import { ipv4Addresses, isPrivateIpv4, parseEcoRouterInterfaces, sameSubnet } from "./basic-network.js";

const linuxTimezoneVmids = [100, 104, 105, 106];
const routerTimezoneVmids = [101, 102];

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

function ipv4ToInt(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return octets.reduce((result, value) => ((result << 8) | value) >>> 0, 0);
}

export function parseDhcpServerConfig(config) {
  const addressPools = new Map();
  const servers = [];
  const bindings = [];
  let server = null;
  let networkInterface = null;
  for (const rawLine of config.split(/\r?\n/)) {
    const addressPool = rawLine.match(/^ip\s+pool\s+(\S+)\s+(\d+(?:\.\d+){3})-(\d+(?:\.\d+){3})\s*$/i);
    if (addressPool) {
      addressPools.set(addressPool[1], { name: addressPool[1], start: addressPool[2], end: addressPool[3] });
      server = null;
      networkInterface = null;
      continue;
    }
    const serverMatch = rawLine.match(/^dhcp-server\s+(\d+)\s*$/i);
    if (serverMatch) {
      server = { number: Number(serverMatch[1]), poolName: null, mask: null, gateway: null, dns: null, domain: null };
      servers.push(server);
      networkInterface = null;
      continue;
    }
    const interfaceMatch = rawLine.match(/^interface\s+(\S+)/i);
    if (interfaceMatch) {
      networkInterface = interfaceMatch[1];
      server = null;
      continue;
    }
    if (/^[^\s!]/.test(rawLine)) {
      server = null;
      networkInterface = null;
    }
    if (server) {
      const pool = rawLine.match(/^\s+pool\s+(\S+)\s+\d+\s*$/i);
      if (pool) server.poolName = pool[1];
      const mask = rawLine.match(/^\s+mask\s+(\d+)\s*$/i);
      if (mask) server.mask = Number(mask[1]);
      const gateway = rawLine.match(/^\s+gateway\s+(\d+(?:\.\d+){3})\s*$/i);
      if (gateway) server.gateway = gateway[1];
      const dns = rawLine.match(/^\s+dns\s+(\d+(?:\.\d+){3})\s*$/i);
      if (dns) server.dns = dns[1];
      const domain = rawLine.match(/^\s+domain-name\s+(\S+)\s*$/i);
      if (domain) server.domain = domain[1];
    }
    if (networkInterface) {
      const binding = rawLine.match(/^\s+dhcp-server\s+(\d+)\s*$/i);
      if (binding) bindings.push({ interface: networkInterface, server: Number(binding[1]) });
    }
  }
  return { addressPools, servers, bindings };
}

export function parseClientDhcp(output) {
  const method = output.match(/^METHOD=(\S+)/m)?.[1]?.toLowerCase() || null;
  const address = output.match(/^IP4\.ADDRESS\[\d+\]:\s*(\d+(?:\.\d+){3})\/(\d+)/m);
  const gateway = output.match(/^IP4\.GATEWAY:\s*(\d+(?:\.\d+){3})/m)?.[1] || null;
  const dns = [...output.matchAll(/^IP4\.DNS\[\d+\]:\s*(\d+(?:\.\d+){3})/gm)].map((match) => match[1]);
  const domains = [...output.matchAll(/^IP4\.(?:DOMAIN|SEARCHES)\[\d+\]:\s*(\S+)/gm)].map((match) => match[1]);
  return { method, address: address?.[1] || null, prefix: address ? Number(address[2]) : null, gateway, dns, domains };
}

function validateDhcp(routerConfig, routerBrief, serverAddresses, hqServerSocket, clientOutput) {
  const parsed = parseDhcpServerConfig(routerConfig);
  const routerInterfaces = parseEcoRouterInterfaces(routerBrief);
  const hqServerAddress = serverAddresses.find((entry) => entry.prefix === 27 && isPrivateIpv4(entry.address));
  let matched = null;
  for (const server of parsed.servers) {
    const binding = parsed.bindings.find((entry) => entry.server === server.number);
    const endpoint = binding && routerInterfaces.find((entry) => entry.name.toLowerCase() === binding.interface.toLowerCase() && entry.prefix === 24);
    const pool = parsed.addressPools.get(server.poolName);
    if (binding && endpoint && pool) {
      matched = { server, binding, endpoint, pool };
      break;
    }
  }
  const poolStart = matched ? ipv4ToInt(matched.pool.start) : null;
  const poolEnd = matched ? ipv4ToInt(matched.pool.end) : null;
  const gatewayValue = matched ? ipv4ToInt(matched.endpoint.address) : null;
  const poolValid = Boolean(matched && poolStart != null && poolEnd != null && poolStart <= poolEnd
    && sameSubnet(matched.pool.start, matched.endpoint.address, 24)
    && sameSubnet(matched.pool.end, matched.endpoint.address, 24)
    && !(gatewayValue >= poolStart && gatewayValue <= poolEnd));
  const optionsValid = Boolean(matched && matched.server.mask === 24
    && matched.server.gateway === matched.endpoint.address
    && hqServerAddress && matched.server.dns === hqServerAddress.address
    && matched.server.domain?.toLowerCase() === "au-team.irpo");
  const hqServerNotServingDhcp = !/LISTENING_UDP67=yes/.test(hqServerSocket);
  const client = parseClientDhcp(clientOutput);
  const clientValid = Boolean(matched && client.method === "auto" && client.address && client.prefix === 24
    && isPrivateIpv4(client.address) && sameSubnet(client.address, matched.endpoint.address, 24)
    && client.gateway === matched.endpoint.address
    && hqServerAddress && client.dns.includes(hqServerAddress.address)
    && client.domains.some((domain) => domain.replace(/\.$/, "").toLowerCase() === "au-team.irpo"));
  return { matched, hqServerAddress, poolValid, optionsValid, hqServerNotServingDhcp, client, clientValid };
}

async function collectLinuxTimezone(vmid, adapter, report) {
  try {
    report({ kind: "command", vmid, command: "timedatectl show -p Timezone --value; date +%:z", message: `Проверяем часовой пояс VM ${vmid}` });
    const output = outputOf(await adapter.guestExec(vmid, "/bin/sh", ["-lc", "timedatectl show -p Timezone --value 2>/dev/null; date +%:z"]));
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return { zone: lines[0] || null, offset: lines[1] || null, error: null };
  } catch (error) {
    return { zone: null, offset: null, error: errorSummary(error) };
  }
}

export async function applyDhcpAndTimezoneChecks(assessment, adapter, serial, report = () => {}) {
  const byVmid = new Map(assessment.devices.map((device) => [device.vmid, device]));
  const startedAt = performance.now();
  const duration = () => Math.max(1, Math.round(performance.now() - startedAt));

  const linuxTimezones = new Map(await Promise.all(linuxTimezoneVmids.map(async (vmid) => [vmid, await collectLinuxTimezone(vmid, adapter, report)])));
  const routerData = new Map(await Promise.all(routerTimezoneVmids.map(async (vmid) => {
    try {
      const credentials = await adapter.vmConsoleCredentials(vmid);
      report({ kind: "command", vmid, command: "show running-config", message: `Проверяем UTC+5 на VM ${vmid}` });
      const config = await serial.getRunningConfig(vmid, credentials);
      return [vmid, { config, error: null }];
    } catch (error) {
      return [vmid, { config: "", error: errorSummary(error) }];
    }
  })));

  for (const vmid of linuxTimezoneVmids) {
    const device = byVmid.get(vmid);
    const result = linuxTimezones.get(vmid);
    const existingId = vmid === 105 ? "brsrv-time" : `${device.id}-timezone`;
    const check = upsertCheck(device, existingId, {
      title: "Часовой пояс",
      maxScore: vmid === 105 ? 3 : 1,
      method: "QEMU Guest Agent · timedatectl",
      expected: "Asia/Yekaterinburg · UTC+05:00"
    });
    if (result.error) setResult(check, "unknown", `QGA недоступен · ${result.error}`, duration());
    else {
      const valid = result.zone === "Asia/Yekaterinburg" && result.offset === "+05:00";
      setResult(check, valid ? "pass" : "fail", `timezone=${result.zone || "не найден"} · UTC offset=${result.offset || "не найден"}`, duration());
    }
    reportResult(report, device, check);
  }

  for (const vmid of routerTimezoneVmids) {
    const device = byVmid.get(vmid);
    const result = routerData.get(vmid);
    const prefix = vmid === 101 ? "hq" : "br";
    const check = upsertCheck(device, `${prefix}-timezone`, {
      title: "Часовой пояс",
      maxScore: 1,
      method: "EcoRouter serial CLI",
      expected: "ntp timezone utc+5"
    });
    if (result.error) setResult(check, "unknown", `Serial CLI недоступен · ${result.error}`, duration());
    else {
      const configured = /^\s*ntp\s+timezone\s+utc\s*\+?0?5(?::?00)?\s*$/im.test(result.config);
      const actual = result.config.match(/^\s*ntp\s+timezone\s+(\S.*?)\s*$/im)?.[1] || "не настроен";
      setResult(check, configured ? "pass" : "fail", `получено=${actual} · ожидается=utc+5`, duration());
    }
    reportResult(report, device, check);
  }

  const hqRouter = routerData.get(101);
  let dhcpData = null;
  let dhcpError = hqRouter.error;
  try {
    const [brief, serverInterfaces, hqServerSocket, clientOutput] = await Promise.all([
      (async () => {
        const credentials = await adapter.vmConsoleCredentials(101);
        return serial.getIpInterfaceBrief(101, credentials);
      })(),
      adapter.guestCommand(104, "network-get-interfaces"),
      adapter.guestExec(104, "/bin/sh", ["-lc", "if ss -H -lun 2>/dev/null | grep -Eq '(^|[[:space:]])[^[:space:]]*:67[[:space:]]'; then echo LISTENING_UDP67=yes; else echo LISTENING_UDP67=no; fi"]),
      adapter.guestExec(106, "/bin/sh", ["-lc", "uuid=$(nmcli -t -f UUID,DEVICE connection show --active 2>/dev/null | awk -F: '$2 != \"lo\" {print $1; exit}'); printf 'METHOD='; nmcli -g ipv4.method connection show \"$uuid\" 2>/dev/null; nmcli device show ens19 2>/dev/null"])
    ]);
    dhcpData = validateDhcp(hqRouter.config, brief, ipv4Addresses(serverInterfaces), outputOf(hqServerSocket), outputOf(clientOutput));
  } catch (error) {
    dhcpError ||= errorSummary(error);
  }

  const hqDevice = byVmid.get(101);
  const serverCheck = upsertCheck(hqDevice, "hq-dhcp-server", {
    title: "DHCP-сервер VLAN 200 на HQ-RTR",
    maxScore: 4,
    method: "EcoRouter CLI + QEMU Guest Agent",
    expected: "pool /24 · исключён адрес HQ-RTR · gateway=HQ-RTR · DNS=HQ-SRV · domain=au-team.irpo"
  });
  if (dhcpError) setResult(serverCheck, "unknown", `Данные недоступны · ${dhcpError}`, duration());
  else {
    const valid = Boolean(dhcpData.matched && dhcpData.poolValid && dhcpData.optionsValid && dhcpData.hqServerNotServingDhcp);
    setResult(serverCheck, valid ? "pass" : "fail",
      `HQ-RTR server=${dhcpData.matched ? dhcpData.matched.server.number : "не найден"} · pool=${dhcpData.poolValid ? "корректен" : "ошибка"} · параметры=${dhcpData.optionsValid ? "корректны" : "ошибка"} · DHCP на HQ-SRV=${dhcpData.hqServerNotServingDhcp ? "нет" : "обнаружен"}`, duration());
  }
  reportResult(report, hqDevice, serverCheck);

  const cliDevice = byVmid.get(106);
  const clientCheck = upsertCheck(cliDevice, "cli-address", {
    title: "Получение параметров по DHCP",
    maxScore: 4,
    method: "QEMU Guest Agent + конфигурация HQ-RTR",
    expected: "ipv4.method=auto · адрес /24 · gateway=HQ-RTR · DNS=HQ-SRV · au-team.irpo"
  });
  if (dhcpError) setResult(clientCheck, "unknown", `Данные недоступны · ${dhcpError}`, duration());
  else {
    const valid = Boolean(serverCheck.status === "pass" && dhcpData.clientValid);
    setResult(clientCheck, valid ? "pass" : "fail",
      `method=${dhcpData.client.method || "не найден"} · адрес=${dhcpData.client.address ? `${dhcpData.client.address}/${dhcpData.client.prefix}` : "нет"} · gateway=${dhcpData.client.gateway || "нет"} · DNS=${dhcpData.client.dns.join(",") || "нет"} · domain=${dhcpData.client.domains.join(",") || "нет"} · сервер HQ-RTR=${serverCheck.status === "pass" ? "подтверждён" : "не подтверждён"}`, duration());
  }
  reportResult(report, cliDevice, clientCheck);
}

