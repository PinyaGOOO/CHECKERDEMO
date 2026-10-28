const expected = {
  vmid: 104,
  hostname: "hq-srv.au-team.irpo",
  ipv4: "192.168.10.10",
  prefix: 27,
  services: ["chronyd", "sshd", "named"]
};

function elapsed(startedAt) {
  return Math.max(1, Math.round(performance.now() - startedAt));
}

function realIpv4(interfaces) {
  return interfaces.flatMap((item) =>
    (item["ip-addresses"] || [])
      .filter((address) => address["ip-address-type"] === "ipv4" && !address["ip-address"].startsWith("127."))
      .map((address) => ({ name: item.name, address: address["ip-address"], prefix: address.prefix }))
  );
}

export async function collectHqServerChecks(adapter) {
  const result = {};

  let startedAt = performance.now();
  try {
    await adapter.guestCommand(expected.vmid, "ping");
    result["hqsrv-agent"] = {
      status: "pass", score: 2, source: "live", duration: elapsed(startedAt),
      evidence: "guest-ping: OK · qemu-guest-agent отвечает"
    };
  } catch (error) {
    result["hqsrv-agent"] = {
      status: "fail", score: 0, source: "live", duration: elapsed(startedAt),
      evidence: `guest-ping: ERROR · ${error.message}`
    };
    return result;
  }

  startedAt = performance.now();
  try {
    const [host, interfaces] = await Promise.all([
      adapter.guestCommand(expected.vmid, "get-host-name"),
      adapter.guestCommand(expected.vmid, "network-get-interfaces")
    ]);
    const hostname = host["host-name"] || "не определён";
    const ipv4 = realIpv4(interfaces);
    const hostnameOk = hostname.toLowerCase() === expected.hostname;
    const addressOk = ipv4.some((item) => item.address === expected.ipv4 && item.prefix === expected.prefix);
    const score = (hostnameOk ? 1 : 0) + (addressOk ? 2 : 0);
    result["hqsrv-hostname"] = {
      status: score === 3 ? "pass" : score > 0 ? "warning" : "fail",
      score,
      source: "live",
      duration: elapsed(startedAt),
      evidence: `hostname=${hostname} · IPv4=${ipv4.length ? ipv4.map((item) => `${item.name}:${item.address}/${item.prefix}`).join(", ") : "отсутствует"}`
    };
  } catch (error) {
    result["hqsrv-hostname"] = {
      status: "fail", score: 0, source: "live", duration: elapsed(startedAt),
      evidence: `Не удалось получить hostname/интерфейсы: ${error.message}`
    };
  }

  startedAt = performance.now();
  try {
    const serviceResult = await adapter.guestExec(expected.vmid, "/usr/bin/systemctl", ["is-active", ...expected.services]);
    const states = (serviceResult["out-data"] || "").trim().split(/\r?\n/);
    const active = expected.services.filter((_, index) => states[index] === "active");
    const inactive = expected.services.filter((_, index) => states[index] !== "active");
    const score = Math.round(active.length / expected.services.length * 5);
    result["hqsrv-services"] = {
      status: active.length === expected.services.length ? "pass" : active.length ? "warning" : "fail",
      score,
      source: "live",
      duration: elapsed(startedAt),
      evidence: `active: ${active.join(", ") || "нет"} · inactive: ${inactive.join(", ") || "нет"}`
    };
  } catch (error) {
    result["hqsrv-services"] = {
      status: "fail", score: 0, source: "live", duration: elapsed(startedAt),
      evidence: `Проверка systemd завершилась ошибкой: ${error.message}`
    };
  }

  return result;
}

export function applyCheckResults(device, results) {
  for (const check of device.checks) {
    if (results[check.id]) Object.assign(check, results[check.id]);
  }
  const liveChecks = device.checks.filter((check) => check.source === "live");
  device.score = liveChecks.reduce((sum, check) => sum + check.score, 0);
  device.assessedMaxScore = liveChecks.reduce((sum, check) => sum + check.maxScore, 0);
  device.checkMode = Object.keys(results).length ? "live" : "demo";
  return device;
}
