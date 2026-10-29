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

export function parseEcoRouterUser(config, username) {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = config.search(new RegExp(`^username\\s+${escaped}\\s*$`, "im"));
  if (start < 0) return null;
  const block = config.slice(start).split(/\r?\n(?=\S)/)[0];
  return {
    passwordConfigured: /^\s+password\s+\S+/im.test(block),
    role: block.match(/^\s+role\s+(\S+)/im)?.[1] || null
  };
}

async function collectLinuxUser(vmid, adapter, report) {
  try {
    report({ kind: "command", vmid, command: "getent passwd sshuser; sudo -n true", message: `Проверяем sshuser на VM ${vmid}` });
    const script = [
      "uid=$(id -u sshuser 2>/dev/null || true)",
      "groups=$(id -nG sshuser 2>/dev/null || true)",
      "hash=$(getent shadow sshuser 2>/dev/null | cut -d: -f2)",
      "password=no",
      "if test -n \"$hash\" && test \"$hash\" != '!' && test \"$hash\" != '*'; then HASH=\"$hash\" perl -e 'exit(crypt(\"P@ssw0rd\", $ENV{HASH}) eq $ENV{HASH} ? 0 : 1)' 2>/dev/null && password=yes; fi",
      "sudo_ok=no",
      "runuser -u sshuser -- sudo -n true >/dev/null 2>&1 && sudo_ok=yes",
      "printf 'UID=%s\\nGROUPS=%s\\nPASSWORD=%s\\nSUDO=%s\\n' \"$uid\" \"$groups\" \"$password\" \"$sudo_ok\""
    ].join("; ");
    const output = outputOf(await adapter.guestExec(vmid, "/bin/sh", ["-lc", script]));
    return {
      uid: Number(output.match(/^UID=(\d+)/m)?.[1] || 0),
      password: /^PASSWORD=yes$/m.test(output),
      sudo: /^SUDO=yes$/m.test(output),
      error: null
    };
  } catch (error) {
    return { error: errorSummary(error) };
  }
}

export async function applyUserChecks(assessment, adapter, serial, report = () => {}) {
  const byVmid = new Map(assessment.devices.map((device) => [device.vmid, device]));
  const startedAt = performance.now();
  const duration = () => Math.max(1, Math.round(performance.now() - startedAt));

  const linuxUsers = new Map(await Promise.all([104, 105].map(async (vmid) => [vmid, await collectLinuxUser(vmid, adapter, report)])));
  for (const vmid of [104, 105]) {
    const device = byVmid.get(vmid);
    const result = linuxUsers.get(vmid);
    const check = upsertCheck(device, `${device.id}-sshuser`, {
      title: "Пользователь sshuser",
      maxScore: 2,
      method: "QEMU Guest Agent · id + sudo",
      expected: "UID=2026 · пароль установлен · sudo выполняется без запроса пароля"
    });
    if (result.error) setResult(check, "unknown", `QGA недоступен · ${result.error}`, duration());
    else {
      const valid = result.uid === 2026 && result.password && result.sudo;
      setResult(check, valid ? "pass" : "fail", `UID=${result.uid || "нет"} · пароль=${result.password ? "верный" : "не подтверждён"} · sudo без пароля=${result.sudo ? "да" : "нет"}`, duration());
    }
    reportResult(report, device, check);
  }

  for (const vmid of [101, 102]) {
    const device = byVmid.get(vmid);
    const prefix = vmid === 101 ? "hq" : "br";
    const check = upsertCheck(device, `${prefix}-net-admin`, {
      title: "Пользователь net_admin",
      maxScore: 2,
      method: "EcoRouter serial CLI · проверка входа",
      expected: "net_admin · роль admin · пароль подтверждён входом"
    });
    try {
      const credentials = await adapter.vmConsoleCredentials(vmid);
      report({ kind: "command", vmid, command: "show running-config", message: `Проверяем net_admin на ${device.name}` });
      const config = await serial.getRunningConfig(vmid, credentials);
      const user = parseEcoRouterUser(config, "net_admin");
      const login = user?.role?.toLowerCase() === "admin" && user.passwordConfigured
        ? await serial.testCredentials(vmid, { username: "net_admin", password: "P@ssw0rd" })
        : false;
      const valid = Boolean(user && user.passwordConfigured && user.role?.toLowerCase() === "admin" && login);
      setResult(check, valid ? "pass" : "fail", `пользователь=${user ? "есть" : "нет"} · пароль=${user?.passwordConfigured ? "настроен" : "нет"} · роль=${user?.role || "нет"} · вход=${login ? "успешен" : "не подтверждён"}`, duration());
    } catch (error) {
      setResult(check, "unknown", `Serial CLI недоступен · ${errorSummary(error)}`, duration());
    }
    reportResult(report, device, check);
  }
}

