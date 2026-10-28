import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/data/assessment.js";
import { ProxmoxSshAdapter } from "../src/adapters/proxmox-ssh.js";
import { applyCheckResults, collectHqServerChecks } from "../src/checks/hq-server.js";

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
  assert.equal(device.score, 11);
});
