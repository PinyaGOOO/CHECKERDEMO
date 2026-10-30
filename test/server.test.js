import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/data/assessment.js";
import { ProxmoxSshAdapter } from "../src/adapters/proxmox-ssh.js";
import { applyCheckResults, collectHqServerChecks } from "../src/checks/hq-server.js";
import { applyHostnameChecks, parseEcoRouterDomain, recalculateDeviceScores } from "../src/checks/hostnames.js";
import { EcoRouterSerialAdapter, parseEcoRouterHostname } from "../src/adapters/ecorouter-serial.js";
import { applyTopologyNetworkChecks, ipv4Addresses, routeGateway, parseEcoRouterInterfaces, isPrivateIpv4, isUsableHost, sameSubnet, rangesOverlap } from "../src/checks/basic-network.js";
import { hasMasquerade, te0BindingValid, networkCidr } from "../src/checks/internet-access.js";
import { parseOspfState, parseTunnel, parseVlanTrunks, parseVmNics } from "../src/checks/ecorouter-routing.js";
import { parseClientDhcp, parseDhcpServerConfig, parseResolvSearch } from "../src/checks/dhcp-timezone.js";
import { parseEcoRouterUser } from "../src/checks/users.js";
import { parseSshAssessment } from "../src/checks/ssh.js";
import { parseHostQueries } from "../src/checks/dns.js";
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
  assert.equal(parseEcoRouterHostname("show hostname\nbr-rtr\nbr-rtr>\nend\n"), "br-rtr");
});

test("EcoRouter adapter shares one running-config snapshot per assessment", async () => {
  const serial = new EcoRouterSerialAdapter();
  let calls = 0;
  serial.runCommand = async () => {
    calls += 1;
    return "hostname hq-rtr\ninterface te0\n ip address 10.0.0.1/28\n";
  };
  serial.beginSnapshot();
  const credentials = { username: "admin", password: "secret" };
  const [config, hostname, interfaces] = await Promise.all([
    serial.getRunningConfig(101, credentials),
    serial.getHostname(101, credentials),
    serial.getIpInterfaceBrief(101, credentials)
  ]);
  assert.match(config, /hostname hq-rtr/);
  assert.equal(hostname, "hq-rtr");
  assert.match(interfaces, /interface te0/);
  assert.equal(calls, 1);
  serial.beginSnapshot();
  await serial.getRunningConfig(101, credentials);
  assert.equal(calls, 2);
});

test("EcoRouter domain parser reads ip domain name independently from hostname", () => {
  assert.equal(parseEcoRouterDomain("hostname hq-rtr\nip domain name au-team.irpo\n"), "au-team.irpo");
  assert.equal(parseEcoRouterDomain("hostname hq-rtr\nip domain-name au-team.irpo\n"), "au-team.irpo");
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

  assert.equal(te0BindingValid("port te0\n service-instance int\n  encapsulation untagged\n!\ninterface int\n", "int"), true);

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

test("EcoRouter routing parsers recognize VLAN trunk, GRE and protected OSPF", () => {
  const config = `
router ospf 1
 passive-interface default
 no passive-interface tunnel.7
!
port te1
 service-instance servers
  encapsulation dot1q 100
 service-instance clients
  encapsulation dot1q 200
 service-instance management
  encapsulation dot1q 999
!
interface tunnel.7
 ip address 10.10.10.0/31
 ip tunnel 172.20.0.2 172.20.1.2 mode gre
 ip ospf authentication message-digest
 ip ospf message-digest-key 1 md5 encrypted-value
!`;
  assert.deepEqual(parseVlanTrunks(config)[0].services.map((entry) => entry.vlan), [100, 200, 999]);
  assert.deepEqual(parseVmNics("net0: virtio=AA:BB,bridge=HQ_NET,tag=100\nnet1: virtio=CC:DD,bridge=ISP_HQ\n"), [
    { bridge: "HQ_NET", tag: 100 }, { bridge: "ISP_HQ", tag: null }
  ]);
  const tunnel = parseTunnel(config, "tunnel.7 10.10.10.0/31 up default");
  assert.equal(tunnel.mode, "gre");
  assert.equal(tunnel.status, "up");
  assert.equal(tunnel.auth && tunnel.authKey, true);
  const ospf = parseOspfState(config, "Total number of full neighbors: 1\n1.1.1.1 1 Full/DR 00:00:30 10.10.10.1 tunnel.7", "O 192.168.1.0/24 [110/2] via 10.10.10.1", "tunnel.7");
  assert.equal(ospf.passiveDefault && ospf.onlyTunnelActive && ospf.neighborOnTunnel, true);
  assert.deepEqual(ospf.routeNetworks, ["192.168.1.0/24"]);
});

test("DHCP parsers recognize an EcoRouter server and a NetworkManager lease", () => {
  const config = `
ip pool VLAN200 192.168.200.2-192.168.200.254
dhcp-server 1
 pool VLAN200 1
  mask 24
  gateway 192.168.200.1
  dns 192.168.100.2
  domain-name au-team.irpo
!
interface clients
 ip address 192.168.200.1/24
 dhcp-server 1
!`;
  const parsed = parseDhcpServerConfig(config);
  assert.deepEqual(parsed.addressPools.get("VLAN200"), { name: "VLAN200", start: "192.168.200.2", end: "192.168.200.254" });
  assert.equal(parsed.servers[0].dns, "192.168.100.2");
  assert.deepEqual(parsed.bindings, [{ interface: "clients", server: 1 }]);
  assert.deepEqual(parseClientDhcp(`METHOD=auto
IP4.ADDRESS[1]: 192.168.200.10/24
IP4.GATEWAY: 192.168.200.1
IP4.DNS[1]: 192.168.100.2
IP4.DOMAIN[1]: au-team.irpo
`), {
    method: "auto", address: "192.168.200.10", prefix: 24, gateway: "192.168.200.1",
    dns: ["192.168.100.2"], domains: ["au-team.irpo"]
  });
  assert.deepEqual(parseResolvSearch("nameserver 192.168.100.2\n---RESOLV---\nsearch au-team.irpo example.test\n"), ["au-team.irpo", "example.test"]);
});

test("EcoRouter user parser requires a password and admin role", () => {
  assert.deepEqual(parseEcoRouterUser("username net_admin\n password encrypted-value\n role admin\n!\n", "net_admin"), {
    passwordConfigured: true,
    role: "admin"
  });
  assert.equal(parseEcoRouterUser("username admin\n role admin\n", "net_admin"), null);
});

test("SSH assessment parser reads effective policy and listening ports", () => {
  const state = parseSshAssessment(`port 2026
allowusers sshuser
maxauthtries 2
banner /etc/openssh/banner
---LISTEN---
LISTEN 0 128 0.0.0.0:2026 0.0.0.0:*
LISTEN 0 128 [::]:2026 [::]:*
---SERVICE---
active
---BANNER---
Authorized access only
`);
  assert.deepEqual(state.ports, [2026]);
  assert.deepEqual(state.allowUsers, ["sshuser"]);
  assert.equal(state.maxAuthTries, 2);
  assert.equal(state.active && state.listens2026 && !state.listens22, true);
  assert.equal(state.banner, "Authorized access only");
});

test("DNS host parser extracts A and PTR answers", () => {
  const records = parseHostQueries(`BEGIN_A|hq-srv.au-team.irpo
hq-srv.au-team.irpo has address 192.168.100.2
END
BEGIN_PTR|192.168.100.2
2.100.168.192.in-addr.arpa domain name pointer hq-srv.au-team.irpo.
END
`);
  assert.deepEqual(records.a.get("hq-srv.au-team.irpo"), ["192.168.100.2"]);
  assert.deepEqual(records.ptr.get("192.168.100.2"), ["hq-srv.au-team.irpo"]);
  assert.equal(records.toolMissing, false);
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
