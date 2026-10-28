import { ProxmoxSshAdapter } from "../adapters/proxmox-ssh.js";
import { applyCheckResults, collectHqServerChecks } from "../checks/hq-server.js";
import { EcoRouterSerialAdapter } from "../adapters/ecorouter-serial.js";
import { applyEcoRouterHostnameChecks, applyHostnameChecks, recalculateDeviceScores } from "../checks/hostnames.js";

const adapter = new ProxmoxSshAdapter({
  alias: process.env.CHECKER_SSH_ALIAS || "checker",
  transport: process.env.CHECKER_TRANSPORT === "local" ? "local" : "ssh"
});
const ecoRouterSerial = new EcoRouterSerialAdapter();
let cache = null;
let cachedAt = 0;
const cacheTtl = 5_000;

export async function getInfrastructure({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < cacheTtl) return cache;
  cache = await adapter.inventory();
  cachedAt = Date.now();
  return cache;
}

export async function applyLiveInfrastructure(assessment) {
  try {
    const infrastructure = await getInfrastructure();
    const byVmid = new Map(infrastructure.vms.map((vm) => [vm.vmid, vm]));
    for (const device of assessment.devices) {
      const vm = byVmid.get(device.vmid);
      if (!vm) continue;
      device.state = vm.status;
      device.live = vm;
      for (const check of device.checks) {
        check.status = "unknown";
        check.score = 0;
        check.source = "pending";
        check.evidence = "Проверка для этого критерия ещё не подключена";
        check.duration = null;
      }
      device.score = 0;
      device.assessedMaxScore = 0;
      device.checkMode = "pending";
    }
    assessment.lab.mode = "live";
    assessment.lab.connection = {
      ok: true,
      source: infrastructure.source,
      alias: infrastructure.alias,
      node: infrastructure.node,
      fetchedAt: infrastructure.fetchedAt
    };
    const hqServer = assessment.devices.find((device) => device.vmid === 104);
    if (hqServer?.state === "running") {
      applyCheckResults(hqServer, await collectHqServerChecks(adapter));
    }
    await applyHostnameChecks(assessment, adapter);
    if (adapter.transport === "local") {
      await applyEcoRouterHostnameChecks(assessment, adapter, ecoRouterSerial);
    }
    recalculateDeviceScores(assessment);
  } catch (error) {
    assessment.lab.mode = "mock";
    assessment.lab.connection = {
      ok: false,
      source: "mock-fallback",
      message: error.code === "ETIMEDOUT" ? "SSH timeout" : error.message
    };
  }
  return assessment;
}

export function resetInfrastructureCache() {
  cache = null;
  cachedAt = 0;
}
