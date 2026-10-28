import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/data/assessment.js";
import { ProxmoxSshAdapter } from "../src/adapters/proxmox-ssh.js";
import { applyCheckResults, collectHqServerChecks } from "../src/checks/hq-server.js";
import { applyHostnameChecks, recalculateDeviceScores } from "../src/checks/hostnames.js";
import { parseEcoRouterHostname } from "../src/adapters/ecorouter-serial.js";

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
  const router = data.devices.find((device) => device.vmid === 101);
  assert.equal(isp.checks.find((check) => check.id === "isp-hostname").status, "pass");
  assert.equal(isp.assessedMaxScore, 1);
  assert.equal(router.checks.find((check) => check.id === "hq-hostname").source, "unavailable");
  assert.equal(router.assessedMaxScore, 0);
});

test("EcoRouter serial output parser extracts hostname", () => {
  const output = "ecorouter>show hostname\r\n\recorouter\x1b[m\r\n\recorouter>";
  assert.equal(parseEcoRouterHostname(output), "ecorouter");
});
