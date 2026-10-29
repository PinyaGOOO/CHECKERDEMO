import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/data/assessment.js";
import { ProxmoxSshAdapter } from "../src/adapters/proxmox-ssh.js";
import { applyCheckResults, collectHqServerChecks } from "../src/checks/hq-server.js";
import { applyHostnameChecks, parseEcoRouterDomain, recalculateDeviceScores } from "../src/checks/hostnames.js";
import { parseEcoRouterHostname } from "../src/adapters/ecorouter-serial.js";
import { applyTopologyNetworkChecks, ipv4Addresses, routeGateway, parseEcoRouterInterfaces, isPrivateIpv4, isUsableHost, sameSubnet, rangesOverlap } from "../src/checks/basic-network.js";
import { hasMasquerade, te0BindingValid, networkCidr } from "../src/checks/internet-access.js";
import { parseTcpdumpLine } from "../src/services/traffic-capture.js";

test("assessment scores are internally consistent", () => {
  const data = snapshot();
  assert.equal(data.devices.length, 7);
  for (const device of data.devices) {
    assert.equal(device.score, device.checks.reduce((sum, check) => sum + check.score, 0));
    assert.equal(device.maxScore, device.checks.reduce((sum, check) => sum + check.maxScore, 0));
  }
});

test("Proxmox SSH adapter uses the checker alias by default", () => {
  const adapter = new ProxmoxSshAdapter();
  assert.equal(adapter.alias, "checker");
});

test("Proxmox adapter supports direct local transport", () => {
  const adapter = new ProxmoxSshAdapter({ transport: "local" });
  assert.equal(adapter.transport, "local");
});

test("every check has unique id and evidence", () => {
  const checks = snapshot().devices.flatMap((device) => device.checks);
  assert.equal(new Set(checks.map((check) => check.id)).size, checks.length);
  assert.ok(checks.every((check) => check.evidence && check.method));
});

test("HQ-SRV live checks calculate partial score from guest data", async () => {
  const fakeAdapter = {
    async guestCommand(_vmid, command) {
      if (command === "ping") return { ok: true };
      if (command === "get-host-name") return { "host-name": "wrong-name" };
      if (command === "network-get-interfaces") return [{
        name: "ens19",
        "ip-addresses": [{ "ip-address": "192.168.10.10", "ip-address-type": "ipv4", prefix: 27 }]
      }];
      throw new Error("Unexpected command");
    },
    async guestExec() {
      return { exitcode: 0, "out-data": "active\nactive\ninactive\n" };
    }
  };
  const device = snapshot().devices.find((item) => item.vmid === 104);
  const results = await collectHqServerChecks(fakeAdapter);
  applyCheckResults(device, results);
  assert.equal(results["hqsrv-agent"].score, 2);
  assert.equal(results["hqsrv-hostname"].score, 2);
  assert.equal(results["hqsrv-services"].status, "warning");
  assert.equal(device.checkMode, "live");
  assert.equal(device.score, 7);
  assert.equal(device.assessedMaxScore, 10);
});

test("hostname checks compare case-insensitively and preserve unavailable state", async () => {
  const data = snapshot();
  data.devices.forEach((device) => {
    device.state = "running";
    device.checks.forEach((check) => Object.assign(check, { status: "unknown", score: 0, source: "pending" }));
  });
  const fakeAdapter = {
    async guestCommand(vmid, command) {
      if (vmid !== 100) throw new Error("QEMU guest agent is not running");
      return command === "ping" ? { ok: true } : { "host-name": "isp" };
    }
  };
  await applyHostnameChecks(data, fakeAdapter);
  recalculateDeviceScores(data);
  const isp = data.devices.find((device) => device.vmid === 100);
  const unavailable = data.devices.find((device) => device.vmid === 103);
  assert.equal(isp.checks.find((check) => check.id === "isp-hostname").status, "pass");
  assert.equal(isp.assessedMaxScore, 1);
  assert.equal(unavailable.checks.find((check) => check.id === "fw-hostname").source, "unavailable");
  assert.equal(unavailable.assessedMaxScore, 0);
});

test("EcoRouter serial output parser extracts hostname", () => {
  const output = "ecorouter>show hostname\r\n\recorouter\x1b[m\r\n\recorouter>";
  assert.equal(parseEcoRouterHostname(output), "ecorouter");
});

test("EcoRouter domain parser reads ip domain name independently from hostname", () => {
  assert.equal(parseEcoRouterDomain("hostname hq-rtr\nip domain name au-team.irpo\n"), "au-team.irpo");
  assert.equal(parseEcoRouterDomain("hostname hq-rtr\n"), null);
});

test("basic network helpers ignore loopback and parse default route", () => {
  const addresses = ipv4Addresses([
    { name: "lo", "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4", prefix: 8 }] },
    { name: "ens19", "ip-addresses": [{ "ip-address": "192.168.100.2", "ip-address-type": "ipv4", prefix: 27 }] }
  ]);
  assert.deepEqual(addresses, [{ name: "ens19", address: "192.168.100.2", prefix: 27 }]);
  assert.equal(routeGateway({ "out-data": "default via 192.168.100.1 dev ens19\n" }), "192.168.100.1");
  assert.equal(routeGateway({ exitcode: 0 }), null);
});

test("topology helpers validate RFC1918 endpoints and subnet relationships", () => {
  assert.equal(isPrivateIpv4("10.21.30.1"), true);
  assert.equal(isPrivateIpv4("172.31.255.254"), true);
  assert.equal(isPrivateIpv4("192.168.42.10"), true);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isUsableHost("10.0.0.1", 28), true);
  assert.equal(isUsableHost("10.0.0.0", 28), false);
  assert.equal(isUsableHost("10.0.0.15", 28), false);
  assert.equal(sameSubnet("172.20.8.1", "172.20.8.14", 28), true);
  assert.equal(sameSubnet("172.20.8.1", "172.20.8.17", 28), false);
  assert.equal(rangesOverlap({ address: "10.0.0.1", prefix: 24 }, { address: "10.0.0.129", prefix: 25 }), true);
  assert.equal(rangesOverlap({ address: "10.0.0.1", prefix: 24 }, { address: "10.0.1.1", prefix: 24 }), false);
});

test("EcoRouter interface parser supports brief and configuration output", () => {
  const output = `
Interface  IP-Address      Status
te0        172.20.8.2/28   up
vl100      10.50.0.1/27    up
interface vl200
 ip address 192.168.77.1/24
`;
  assert.deepEqual(parseEcoRouterInterfaces(output), [
    { name: "te0", address: "172.20.8.2", prefix: 28 },
    { name: "vl100", address: "10.50.0.1", prefix: 27 },
    { name: "vl200", address: "192.168.77.1", prefix: 24 }
  ]);
});

test("topology check accepts arbitrary non-overlapping RFC1918 networks", async () => {
  const data = snapshot();
  data.devices.forEach((device) => { device.state = "running"; });
  const linux = new Map([
    [100, [["ens20", "172.20.8.1", 28], ["ens21", "172.20.9.1", 28]]],
    [104, [["ens19", "10.50.0.2", 27]]],
    [105, [["ens19", "192.168.55.2", 28]]],
    [106, [["ens19", "172.22.0.2", 24]]]
  ]);
  const gateways = new Map([[104, "10.50.0.1"], [105, "192.168.55.1"], [106, "172.22.0.1"]]);
  const adapter = {
    async guestCommand(vmid) {
      return linux.get(vmid).map(([name, address, prefix]) => ({
        name,
        "ip-addresses": [{ "ip-address": address, "ip-address-type": "ipv4", prefix }]
      }));
    },
    async guestExec(vmid) {
      return { exitcode: 0, "out-data": `default via ${gateways.get(vmid)} dev ens19\n` };
    },
    async vmConsoleCredentials() { return { username: "test", password: "test" }; }
  };
  const serial = {
    async getIpInterfaceBrief(vmid) {
      return vmid === 101
        ? "te0 172.20.8.2/28 up\nvl100 10.50.0.1/27 up\nvl200 172.22.0.1/24 up\nvl999 192.168.99.1/29 up\n"
        : "te0 172.20.9.2/28 up\nint1 192.168.55.1/28 up\n";
    }
  };
  const events = [];
  await applyTopologyNetworkChecks(data, adapter, serial, (event) => events.push(event));
  const results = events.filter((event) => event.kind === "result");
  assert.equal(results.length, 9);
  assert.ok(results.every((event) => event.check.status === "pass"));
});

test("internet access helpers validate dynamic NAT and EcoRouter WAN binding", () => {
  const nat = "-A POSTROUTING -s 172.20.8.0/28 -o ens19 -j MASQUERADE\n";
  assert.equal(networkCidr("172.20.8.14", 28), "172.20.8.0/28");
  assert.equal(hasMasquerade(nat, "172.20.8.0/28"), true);
  assert.equal(hasMasquerade(nat, "172.20.9.0/28"), false);
  assert.equal(hasMasquerade(nat.replace("ens19", "ens20"), "172.20.8.0/28"), false);

  const config = `
interface uplink
 ip address 172.20.8.2/28
port te0
 service-instance te0/uplink
  encapsulation untagged
  connect ip interface uplink
port te1
 service-instance te1/lan
`;
  assert.equal(te0BindingValid(config, "uplink"), true);
  assert.equal(te0BindingValid(config.replace("encapsulation untagged", "encapsulation dot1q 100"), "uplink"), false);
  assert.equal(te0BindingValid(config, "wrong-interface"), false);
});

test("tcpdump parser extracts real packet metadata and resolves VM MAC addresses", () => {
  const macMap = new Map([["bc:24:11:c1:a4:7a", { vmid: 106, name: "HQ-CLI" }]]);
  const line = "1793200000.125000 bc:24:11:c1:a4:7a > bc:24:11:49:8c:9c, ethertype IPv4 (0x0800), length 74: 192.168.10.2.54321 > 8.8.8.8.443: tcp 0";
  const packet = parseTcpdumpLine(line, "HQ_NET", macMap);
  assert.equal(packet.bridge, "HQ_NET");
  assert.equal(packet.protocol, "TCP");
  assert.equal(packet.srcDevice.vmid, 106);
  assert.equal(packet.srcIp, "192.168.10.2");
  assert.equal(packet.dstIp, "8.8.8.8");
  assert.equal(packet.dstPort, 443);
  assert.equal(packet.length, 74);
});
