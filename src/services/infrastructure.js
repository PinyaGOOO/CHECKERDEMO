import { ProxmoxSshAdapter } from "../adapters/proxmox-ssh.js";
import { EcoRouterSerialAdapter } from "../adapters/ecorouter-serial.js";
import { applyEcoRouterHostnameChecks, applyHostnameChecks, recalculateDeviceScores } from "../checks/hostnames.js";
import { applyTopologyNetworkChecks } from "../checks/basic-network.js";
import { applyInternetAccessChecks } from "../checks/internet-access.js";
import { applyEcoRouterRoutingChecks } from "../checks/ecorouter-routing.js";
import { applyDhcpAndTimezoneChecks } from "../checks/dhcp-timezone.js";

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

export async function applyLiveInfrastructure(assessment, { report = () => {} } = {}) {
  try {
    report({ kind: "command", command: "pvesh get /cluster/resources --type vm", message: "Получаем состояние виртуальных машин" });
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
    await applyHostnameChecks(assessment, adapter, report);
    if (adapter.transport === "local") {
      await applyEcoRouterHostnameChecks(assessment, adapter, ecoRouterSerial, report);
      await applyTopologyNetworkChecks(assessment, adapter, ecoRouterSerial, report);
      await applyInternetAccessChecks(assessment, adapter, ecoRouterSerial, report);
      await applyEcoRouterRoutingChecks(assessment, adapter, ecoRouterSerial, report);
      await applyDhcpAndTimezoneChecks(assessment, adapter, ecoRouterSerial, report);
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
