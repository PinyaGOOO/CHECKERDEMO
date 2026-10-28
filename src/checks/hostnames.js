const domain = "au-team.irpo";

export const hostnameRules = [
  { vmid: 100, checkId: "isp-hostname", expected: "ISP" },
  { vmid: 101, checkId: "hq-hostname", expected: `HQ-RTR.${domain}` },
  { vmid: 102, checkId: "br-hostname", expected: `BR-RTR.${domain}` },
  { vmid: 103, checkId: "fw-hostname", expected: `BR-FW.${domain}` },
  { vmid: 104, checkId: "hqsrv-hostname", expected: `HQ-SRV.${domain}` },
  { vmid: 105, checkId: "brsrv-hostname", expected: `BR-SRV.${domain}` },
  { vmid: 106, checkId: "cli-hostname", expected: `HQ-CLI.${domain}` }
];

function ensureHostnameCheck(device, rule) {
  let check = device.checks.find((item) => item.id === rule.checkId);
  if (!check) {
    check = { id: rule.checkId };
    device.checks.unshift(check);
  }
  Object.assign(check, {
    title: "Hostname",
    maxScore: 1,
    method: "QEMU Guest Agent",
    expected: rule.expected
  });
  return check;
}

function errorSummary(error) {
  return String(error.stderr || error.message || error).trim().split(/\r?\n/)[0];
}

export async function applyHostnameChecks(assessment, adapter) {
  await Promise.all(hostnameRules.map(async (rule) => {
    const device = assessment.devices.find((item) => item.vmid === rule.vmid);
    if (!device) return;
    const check = ensureHostnameCheck(device, rule);

    if (device.state !== "running") {
      Object.assign(check, {
        status: "unknown", score: 0, source: "unavailable", duration: null,
        evidence: `VM остановлена · ожидается ${rule.expected}`
      });
      return;
    }

    const startedAt = performance.now();
    try {
      await adapter.guestCommand(rule.vmid, "ping");
      const response = await adapter.guestCommand(rule.vmid, "get-host-name");
      const actual = response["host-name"] || "";
      const matches = actual.localeCompare(rule.expected, undefined, { sensitivity: "accent" }) === 0;
      Object.assign(check, {
        status: matches ? "pass" : "fail",
        score: matches ? 1 : 0,
        source: "live",
        duration: Math.max(1, Math.round(performance.now() - startedAt)),
        evidence: `ожидается=${rule.expected} · получено=${actual || "пусто"}`
      });
    } catch (error) {
      Object.assign(check, {
        status: "unknown", score: 0, source: "unavailable",
        duration: Math.max(1, Math.round(performance.now() - startedAt)),
        evidence: `Канал QGA недоступен · ${errorSummary(error)}`
      });
    }
  }));
}

export function recalculateDeviceScores(assessment) {
  for (const device of assessment.devices) {
    const liveChecks = device.checks.filter((check) => check.source === "live");
    device.score = liveChecks.reduce((sum, check) => sum + check.score, 0);
    device.assessedMaxScore = liveChecks.reduce((sum, check) => sum + check.maxScore, 0);
    device.checkMode = liveChecks.length ? "live" : "pending";
  }
  return assessment;
}
