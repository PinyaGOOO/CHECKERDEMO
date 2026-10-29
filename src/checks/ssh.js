function outputOf(result) {
  return `${result["out-data"] || ""}${result["err-data"] || ""}`;
}

function errorSummary(error) {
  return String(error.stderr || error.message || error).trim().split(/\r?\n/)[0];
}

function upsertCheck(device, id, values) {
  let check = device.checks.find((item) => item.id === id);
  if (!check) {
    check = { id };
    device.checks.push(check);
  }
  Object.assign(check, values);
  return check;
}

function setResult(check, status, evidence, duration) {
  Object.assign(check, {
    status,
    score: status === "pass" ? check.maxScore : 0,
    source: status === "unknown" ? "unavailable" : "live",
    evidence,
    duration
  });
}

function reportResult(report, device, check) {
  const label = check.status === "pass" ? "выполнено" : check.status === "fail" ? "ошибка" : "недоступно";
  report({ kind: "result", vmid: device.vmid, device: device.name, check: { ...check }, message: `${check.title}: ${label} · ${check.evidence}` });
}

export function parseSshAssessment(output) {
  const [effective = "", rest = ""] = output.split("---LISTEN---");
  const [listening = "", serviceAndBanner = ""] = rest.split("---SERVICE---");
  const [service = "", banner = ""] = serviceAndBanner.split("---BANNER---");
  const ports = [...effective.matchAll(/^port\s+(\d+)\s*$/gim)].map((match) => Number(match[1]));
  const allowUsers = effective.match(/^allowusers\s+(.+)$/im)?.[1]?.trim().split(/\s+/).map((value) => value.toLowerCase()) || [];
  const maxAuthTries = Number(effective.match(/^maxauthtries\s+(\d+)\s*$/im)?.[1] || 0);
  const listens2026 = /(?:^|\s)(?:\[[^\]]+\]|\S+):2026\s/m.test(listening);
  const listens22 = /(?:^|\s)(?:\[[^\]]+\]|\S+):22\s/m.test(listening);
  return {
    ports,
    allowUsers,
    maxAuthTries,
    active: service.trim().split(/\r?\n/)[0] === "active",
    listens2026,
    listens22,
    banner: banner.trim()
  };
}

async function collectSsh(vmid, adapter, report) {
  try {
    report({ kind: "command", vmid, command: "sshd -T; ss -ltn; systemctl is-active sshd", message: `Проверяем защищённый SSH на VM ${vmid}` });
    const script = [
      "sshd_bin=$(command -v sshd || printf /usr/sbin/sshd)",
      "effective=$($sshd_bin -T 2>/dev/null)",
      "printf '%s\\n' \"$effective\"",
      "echo ---LISTEN---",
      "ss -H -ltn 2>/dev/null",
      "echo ---SERVICE---",
      "systemctl is-active sshd 2>/dev/null || true",
      "echo ---BANNER---",
      "banner=$(printf '%s\\n' \"$effective\" | awk '$1 == \"banner\" {print $2; exit}')",
      "test -n \"$banner\" && test \"$banner\" != none && cat \"$banner\" 2>/dev/null || true"
    ].join("; ");
    return { state: parseSshAssessment(outputOf(await adapter.guestExec(vmid, "/bin/sh", ["-lc", script]))), error: null };
  } catch (error) {
    return { state: null, error: errorSummary(error) };
  }
}

export async function applySshChecks(assessment, adapter, report = () => {}) {
  const byVmid = new Map(assessment.devices.map((device) => [device.vmid, device]));
  const startedAt = performance.now();
  const results = new Map(await Promise.all([104, 105].map(async (vmid) => [vmid, await collectSsh(vmid, adapter, report)])));
  for (const vmid of [104, 105]) {
    const device = byVmid.get(vmid);
    const result = results.get(vmid);
    const check = upsertCheck(device, `${device.id}-ssh`, {
      title: "Защищённый доступ SSH",
      maxScore: 3,
      method: "QEMU Guest Agent · sshd -T + ss",
      expected: "порт 2026 · только sshuser · MaxAuthTries 2 · баннер · порт 22 закрыт"
    });
    const duration = Math.max(1, Math.round(performance.now() - startedAt));
    if (result.error) {
      setResult(check, "unknown", `QGA недоступен · ${result.error}`, duration);
    } else {
      const state = result.state;
      const onlyPort2026 = state.ports.length === 1 && state.ports[0] === 2026;
      const onlySshuser = state.allowUsers.length === 1 && state.allowUsers[0] === "sshuser";
      const bannerValid = state.banner.split(/\r?\n/).some((line) => line.trim() === "Authorized access only");
      const valid = onlyPort2026 && onlySshuser && state.maxAuthTries === 2 && bannerValid
        && state.active && state.listens2026 && !state.listens22;
      setResult(check, valid ? "pass" : "fail",
        `sshd=${state.active ? "active" : "не active"} · Port=${state.ports.join(",") || "нет"} · listen 2026=${state.listens2026 ? "да" : "нет"} · listen 22=${state.listens22 ? "да" : "нет"} · AllowUsers=${state.allowUsers.join(",") || "не задан"} · MaxAuthTries=${state.maxAuthTries || "не задан"} · banner=${bannerValid ? "верный" : "ошибка"}`, duration);
    }
    reportResult(report, device, check);
  }
}

