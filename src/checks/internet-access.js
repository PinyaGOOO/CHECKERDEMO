import { ipv4Addresses, parseEcoRouterInterfaces, sameSubnet } from "./basic-network.js";

const routerRules = [
  { vmid: 101, prefix: "hq", ispInterface: "ens20" },
  { vmid: 102, prefix: "br", ispInterface: "ens21" }
];

function errorSummary(error) {
  return String(error.stderr || error.message || error).trim().split(/\r?\n/)[0];
}

function outputOf(result) {
  return `${result["out-data"] || ""}${result["err-data"] || ""}`;
}

function upsertCheck(device, id, values) {
  let check = device.checks.find((item) => item.id === id);
  if (!check) {
    check = { id };
    device.checks.push(check);
  }
  Object.assign(check, { maxScore: 1, ...values });
  return check;
}

function setResult(check, status, evidence, duration) {
  Object.assign(check, {
    status,
    score: status === "pass" ? 1 : 0,
    source: status === "unknown" ? "unavailable" : "live",
    duration,
    evidence
  });
}

function reportResult(report, device, check) {
  const label = check.status === "pass" ? "выполнено" : check.status === "fail" ? "ошибка" : "недоступно";
  report({ kind: "result", vmid: device.vmid, device: device.name, check: { ...check }, message: `${check.title}: ${label} · ${check.evidence}` });
}

function networkCidr(address, prefix) {
  const octets = address.split(".").map(Number);
  let value = octets.reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  value = (value & mask) >>> 0;
  return `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}/${prefix}`;
}

function hasMasquerade(output, sourceCidr) {
  return output.split(/\r?\n/).some((line) =>
    line.includes("-A POSTROUTING")
    && line.includes(`-s ${sourceCidr}`)
    && /\s-o\s+ens19\b/.test(line)
    && /\s-j\s+MASQUERADE\b/.test(line)
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function te0BindingValid(config, interfaceName) {
  const start = config.search(/^\s*port\s+te0\b/im);
  if (start < 0) return false;
  const tail = config.slice(start);
  const nextPort = tail.slice(1).search(/^\s*port\s+\S+/im);
  const block = nextPort < 0 ? tail : tail.slice(0, nextPort + 1);
  const serviceInstance = block.match(/service-instance\s+(\S+)/i)?.[1];
  const explicitBinding = new RegExp(`connect\\s+ip\\s+interface\\s+${escapeRegex(interfaceName)}\\b`, "i").test(block);
  const implicitBinding = serviceInstance?.localeCompare(interfaceName, undefined, { sensitivity: "accent" }) === 0;
  return Boolean(serviceInstance)
    && /encapsulation\s+untagged\b/i.test(block)
    && (explicitBinding || implicitBinding);
}

async function collectIsp(adapter, report) {
  const result = { addresses: [], routeOutput: "", optionsOutput: "", forwardingOutput: "", natOutput: "", error: null };
  try {
    report({ kind: "command", vmid: 100, device: "ISP", command: "qm guest cmd 100 network-get-interfaces", message: "Читаем интерфейсы ISP" });
    result.addresses = ipv4Addresses(await adapter.guestCommand(100, "network-get-interfaces"));
    report({ kind: "command", vmid: 100, device: "ISP", command: "cat /etc/net/ifaces/ens19/options; ip -4 route show default", message: "Проверяем DHCP и маршрут ISP" });
    const upstream = outputOf(await adapter.guestExec(100, "/bin/sh", ["-lc", "cat /etc/net/ifaces/ens19/options 2>/dev/null; printf '\\n---ROUTE---\\n'; /usr/sbin/ip -4 route show default"]));
    [result.optionsOutput, result.routeOutput] = upstream.split("---ROUTE---");
    report({ kind: "command", vmid: 100, device: "ISP", command: "cat /etc/sysctl.conf", message: "Проверяем IP forwarding в /etc/sysctl.conf" });
    result.forwardingOutput = outputOf(await adapter.guestExec(100, "/bin/sh", ["-lc", "cat /etc/sysctl.conf 2>/dev/null"]));
    report({ kind: "command", vmid: 100, device: "ISP", command: "iptables-save -t nat; systemctl is-enabled iptables", message: "Проверяем NAT и сохранение правил" });
    result.natOutput = outputOf(await adapter.guestExec(100, "/bin/sh", ["-lc", "command -v iptables-save >/dev/null && iptables-save -t nat; printf '\\n---SERVICE---\\n'; systemctl is-enabled iptables 2>/dev/null; test -s /etc/sysconfig/iptables && echo persistent=yes"]));
  } catch (error) {
    result.error = errorSummary(error);
  }
  return result;
}

async function collectRouter(rule, adapter, serial, report) {
  const result = { config: "", error: null };
  try {
    const credentials = await adapter.vmConsoleCredentials(rule.vmid);
    result.config = await serial.getRunningConfig(rule.vmid, credentials);
  } catch (error) {
    result.error = errorSummary(error);
  }
  return result;
}

export async function applyInternetAccessChecks(assessment, adapter, serial, report = () => {}) {
  const byVmid = new Map(assessment.devices.map((device) => [device.vmid, device]));
  const startedAt = performance.now();
  const isp = await collectIsp(adapter, report);
  const routers = new Map(await Promise.all(routerRules.map(async (rule) => [rule.vmid, await collectRouter(rule, adapter, serial, report)])));
  const duration = () => Math.max(1, Math.round(performance.now() - startedAt));
  const ispDevice = byVmid.get(100);

  const dhcpCheck = upsertCheck(ispDevice, "isp-upstream-dhcp", {
    title: "Магистральный интерфейс по DHCP",
    method: "QEMU Guest Agent",
    expected: "ens19: BOOTPROTO=dhcp · IPv4 · default route"
  });
  if (isp.error) {
    setResult(dhcpCheck, "unknown", `QGA недоступен · ${isp.error}`, duration());
  } else {
    const address = isp.addresses.find((entry) => entry.name === "ens19");
    const configured = /^\s*BOOTPROTO\s*=\s*dhcp\s*$/im.test(isp.optionsOutput);
    const defaultRoute = /\bdefault\b.*\bdev\s+ens19\b/.test(isp.routeOutput);
    setResult(dhcpCheck, configured && Boolean(address) && defaultRoute ? "pass" : "fail",
      `BOOTPROTO=${configured ? "dhcp" : "не dhcp"} · IPv4=${address ? `${address.address}/${address.prefix}` : "нет"} · default route=${defaultRoute ? "есть" : "нет"}`, duration());
  }
  reportResult(report, ispDevice, dhcpCheck);

  const forwardingCheck = upsertCheck(ispDevice, "isp-forwarding", {
    title: "Пересылка IPv4-пакетов",
    method: "QEMU Guest Agent",
    expected: "net.ipv4.ip_forward = 1 в /etc/sysctl.conf"
  });
  if (isp.error) {
    setResult(forwardingCheck, "unknown", `QGA недоступен · ${isp.error}`, duration());
  } else {
    const configured = isp.forwardingOutput.split(/\r?\n/).some((line) =>
      /^\s*net\.ipv4\.ip_forward\s*=\s*1\s*(?:#.*)?$/.test(line)
    );
    setResult(forwardingCheck, configured ? "pass" : "fail", `/etc/sysctl.conf: ${configured ? "net.ipv4.ip_forward = 1 найдено" : "строка net.ipv4.ip_forward = 1 не найдена"}`, duration());
  }
  reportResult(report, ispDevice, forwardingCheck);

  const linkNetworks = routerRules.map((rule) => {
    const endpoint = isp.addresses.find((entry) => entry.name === rule.ispInterface && entry.prefix === 28);
    return endpoint ? networkCidr(endpoint.address, 28) : null;
  });
  const natCheck = upsertCheck(ispDevice, "isp-nat", {
    title: "Динамический NAT для HQ и BR",
    method: "QEMU Guest Agent · iptables-save",
    expected: "MASQUERADE обеих WAN-подсетей через ens19"
  });
  if (isp.error) {
    setResult(natCheck, "unknown", `QGA недоступен · ${isp.error}`, duration());
  } else {
    const matched = linkNetworks.map((network) => Boolean(network && hasMasquerade(isp.natOutput, network)));
    setResult(natCheck, matched.every(Boolean) ? "pass" : "fail",
      routerRules.map((rule, index) => `${rule.prefix.toUpperCase()}=${linkNetworks[index] || "сеть не найдена"}:${matched[index] ? "есть" : "нет"}`).join(" · "), duration());
  }
  reportResult(report, ispDevice, natCheck);

  const persistenceCheck = upsertCheck(ispDevice, "isp-nat-persistent", {
    title: "Сохранение правил NAT",
    method: "QEMU Guest Agent · systemd",
    expected: "iptables enabled · /etc/sysconfig/iptables не пуст"
  });
  if (isp.error) {
    setResult(persistenceCheck, "unknown", `QGA недоступен · ${isp.error}`, duration());
  } else {
    const enabled = /---SERVICE---\s*enabled\b/s.test(isp.natOutput);
    const persistent = /\bpersistent=yes\b/.test(isp.natOutput);
    setResult(persistenceCheck, enabled && persistent ? "pass" : "fail", `автозапуск=${enabled ? "enabled" : "нет"} · файл правил=${persistent ? "есть" : "нет"}`, duration());
  }
  reportResult(report, ispDevice, persistenceCheck);

  for (const rule of routerRules) {
    const device = byVmid.get(rule.vmid);
    const router = routers.get(rule.vmid);
    const ispEndpoint = isp.addresses.find((entry) => entry.name === rule.ispInterface && entry.prefix === 28);
    const routerInterfaces = parseEcoRouterInterfaces(router.config);
    const routerEndpoint = ispEndpoint ? routerInterfaces.find((entry) => entry.prefix === 28 && sameSubnet(entry.address, ispEndpoint.address, 28) && entry.address !== ispEndpoint.address) : null;

    const routeCheck = upsertCheck(device, `${rule.prefix}-default-route`, {
      title: "Маршрут по умолчанию через ISP",
      method: "EcoRouter serial CLI",
      expected: "0.0.0.0/0 через адрес ISP в общей /28"
    });
    if (router.error || isp.error) {
      setResult(routeCheck, "unknown", `Данные недоступны · ${router.error || isp.error}`, duration());
    } else {
      const found = Boolean(ispEndpoint && new RegExp(`0\\.0\\.0\\.0/0[^\\n]*${escapeRegex(ispEndpoint.address)}`).test(router.config));
      setResult(routeCheck, found ? "pass" : "fail", `шлюз ISP=${ispEndpoint?.address || "не найден"} · default route=${found ? "найден" : "не найден"}`, duration());
    }
    reportResult(report, device, routeCheck);

    const bindingCheck = upsertCheck(device, `${rule.prefix}-wan-binding`, {
      title: "WAN service-instance на te0",
      method: "EcoRouter serial CLI",
      expected: "encapsulation untagged · connect ip interface <WAN>"
    });
    if (router.error || isp.error) {
      setResult(bindingCheck, "unknown", `Данные недоступны · ${router.error || isp.error}`, duration());
    } else {
      const found = Boolean(routerEndpoint && te0BindingValid(router.config, routerEndpoint.name));
      setResult(bindingCheck, found ? "pass" : "fail", `WAN=${routerEndpoint?.name || "не найден"} · te0 untagged binding=${found ? "есть" : "нет"}`, duration());
    }
    reportResult(report, device, bindingCheck);
  }

  const officeInternet = await Promise.all([104, 105, 106].map(async (vmid) => {
    try {
      report({ kind: "command", vmid, command: "ping -c 1 -W 2 77.88.8.8", message: `Проверяем реальный выход в Интернет с VM ${vmid}` });
      const probe = await adapter.guestExec(vmid, "/bin/sh", ["-lc", "ping -c 1 -W 2 77.88.8.8 >/dev/null 2>&1"]);
      return [vmid, { reachable: Number(probe.exitcode ?? probe["exit-code"] ?? 1) === 0, error: null }];
    } catch (error) {
      return [vmid, { reachable: false, error: errorSummary(error) }];
    }
  }));
  for (const [vmid, probe] of officeInternet) {
    const device = byVmid.get(vmid);
    const check = upsertCheck(device, `${device.id}-internet`, {
      title: "Выход в Интернет",
      method: "QEMU Guest Agent · ICMP probe",
      expected: "77.88.8.8 доступен из гостевой системы"
    });
    if (probe.error) setResult(check, "unknown", `Проба недоступна · ${probe.error}`, duration());
    else setResult(check, probe.reachable ? "pass" : "fail", `ping 77.88.8.8: ${probe.reachable ? "успешно" : "нет ответа"}`, duration());
    reportResult(report, device, check);
  }
}

export { hasMasquerade, te0BindingValid, networkCidr };
