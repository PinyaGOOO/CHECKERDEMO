import { isPrivateIpv4, parseEcoRouterInterfaces, sameSubnet } from "./basic-network.js";

const routerVmids = [101, 102];

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

function networkCidr(address, prefix) {
  const value = ipv4ToInt(address);
  if (value == null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (value & mask) >>> 0;
  return `${network >>> 24}.${(network >>> 16) & 255}.${(network >>> 8) & 255}.${network & 255}/${prefix}`;
}

export function parseVlanTrunks(config) {
  const ports = new Map();
  let port = null;
  let service = null;
  for (const rawLine of config.split(/\r?\n/)) {
    const portMatch = rawLine.match(/^port\s+(\S+)/i);
    if (portMatch) {
      port = portMatch[1];
      service = null;
      if (!ports.has(port)) ports.set(port, []);
      continue;
    }
    if (/^[^\s!]/.test(rawLine)) {
      port = null;
      service = null;
    }
    if (!port) continue;
    const serviceMatch = rawLine.match(/^\s+service-instance\s+(\S+)/i);
    if (serviceMatch) {
      service = serviceMatch[1];
      continue;
    }
    const vlanMatch = rawLine.match(/^\s+encapsulation\s+dot1q\s+(\d+)\b/i);
    if (service && vlanMatch) ports.get(port).push({ service, vlan: Number(vlanMatch[1]) });
  }
  return [...ports].map(([name, services]) => ({ name, services }));
}

export function parseVmNics(config) {
  return config.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^net\d+:\s+.*?bridge=([^,\s]+)(?:,|$)/i);
    if (!match) return [];
    const tag = line.match(/(?:^|,)tag=(\d+)(?:,|$)/i)?.[1];
    return [{ bridge: match[1], tag: tag ? Number(tag) : null }];
  });
}

export function parseTunnel(config, brief = "") {
  let current = null;
  const tunnels = [];
  for (const rawLine of config.split(/\r?\n/)) {
    const interfaceMatch = rawLine.match(/^interface\s+(\S+)/i);
    if (interfaceMatch) {
      current = { name: interfaceMatch[1], address: null, prefix: null, source: null, destination: null, mode: null, auth: false, authKey: false };
      tunnels.push(current);
      continue;
    }
    if (/^[^\s!]/.test(rawLine)) current = null;
    if (!current) continue;
    const address = rawLine.match(/^\s+ip\s+address\s+(\d+(?:\.\d+){3})\/(\d+)\b/i);
    if (address) [current.address, current.prefix] = [address[1], Number(address[2])];
    const tunnel = rawLine.match(/^\s+ip\s+tunnel\s+(\d+(?:\.\d+){3})\s+(\d+(?:\.\d+){3})\s+mode\s+(\S+)/i);
    if (tunnel) [current.source, current.destination, current.mode] = [tunnel[1], tunnel[2], tunnel[3].toLowerCase()];
    if (/^\s+ip\s+ospf\s+authentication\s+message-digest\b/i.test(rawLine)) current.auth = true;
    if (/^\s+ip\s+ospf\s+message-digest-key\s+\d+\s+md5\s+\S+/i.test(rawLine)) current.authKey = true;
  }
  const tunnel = tunnels.find((entry) => entry.source && entry.destination && entry.mode) || null;
  if (!tunnel) return null;
  const statusPattern = new RegExp(`^\\s*${tunnel.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\S+\\s+(\\S+)`, "im");
  tunnel.status = brief.match(statusPattern)?.[1]?.toLowerCase() || null;
  return tunnel;
}

export function parseOspfState(config, neighborOutput, routeOutput, tunnelName) {
  const processStart = config.search(/^router\s+ospf\s+\S+/im);
  let processBlock = "";
  if (processStart >= 0) {
    const tail = config.slice(processStart);
    processBlock = tail.split(/\r?\n(?=\S)/)[0];
  }
  const noPassive = [...processBlock.matchAll(/^\s+no\s+passive-interface\s+(\S+)/gim)].map((match) => match[1]);
  const routeNetworks = [...routeOutput.matchAll(/^O\S*\s+(\d+(?:\.\d+){3}\/\d+)\b/gim)].map((match) => match[1]);
  const fullCount = Number(neighborOutput.match(/Total number of full neighbors:\s*(\d+)/i)?.[1] || 0);
  const neighborOnTunnel = Boolean(tunnelName && neighborOutput.split(/\r?\n/).some((line) => /\bFull\//i.test(line) && line.includes(tunnelName)));
  return {
    configured: processStart >= 0,
    passiveDefault: /^\s+passive-interface\s+default\s*$/im.test(processBlock),
    onlyTunnelActive: noPassive.length === 1 && noPassive[0].toLowerCase() === tunnelName?.toLowerCase(),
    fullCount,
    neighborOnTunnel,
    routeNetworks
  };
}

function pairTunnels(left, right, leftInterfaces, rightInterfaces) {
  if (!left || !right) return { valid: false, reason: "туннель не найден" };
  const allowedModes = new Set(["gre", "ipip", "ip-in-ip"]);
  const modeValid = left.mode === right.mode && allowedModes.has(left.mode);
  const addressValid = left.address && right.address
    && left.prefix === right.prefix && left.prefix >= 1 && left.prefix <= 31
    && left.address !== right.address && isPrivateIpv4(left.address) && isPrivateIpv4(right.address)
    && sameSubnet(left.address, right.address, left.prefix);
  const outerValid = left.source === right.destination && left.destination === right.source
    && leftInterfaces.some((entry) => entry.address === left.source)
    && rightInterfaces.some((entry) => entry.address === right.source);
  const statusValid = left.status === "up" && right.status === "up";
  return {
    valid: Boolean(modeValid && addressValid && outerValid && statusValid),
    modeValid,
    addressValid,
    outerValid,
    statusValid,
    reason: `mode=${left.mode}/${right.mode} · tunnel=${left.address}/${left.prefix}↔${right.address}/${right.prefix} · outer=${left.source}↔${left.destination} · status=${left.status}/${right.status}`
  };
}

async function collectRouter(vmid, adapter, serial, report) {
  const result = { config: "", brief: "", neighbors: "", routes: "", interfaces: [], tunnel: null, ospf: null, error: null };
  try {
    const credentials = await adapter.vmConsoleCredentials(vmid);
    result.config = await serial.getRunningConfig(vmid, credentials);
    report({ kind: "command", vmid, command: "show ip ospf neighbor", message: `Проверяем OSPF-соседство на VM ${vmid}` });
    result.neighbors = await serial.runCommand(vmid, credentials, "show ip ospf neighbor", 1_800);
    report({ kind: "command", vmid, command: "show ip route ospf", message: `Читаем маршруты OSPF на VM ${vmid}` });
    result.routes = await serial.runCommand(vmid, credentials, "show ip route ospf", 1_800);
    result.interfaces = parseEcoRouterInterfaces(result.config);
    result.tunnel = parseTunnel(result.config);
    result.ospf = parseOspfState(result.config, result.neighbors, result.routes, result.tunnel?.name);
    if (result.tunnel) result.tunnel.status = result.ospf.neighborOnTunnel ? "up" : "down";
  } catch (error) {
    result.error = errorSummary(error);
  }
  return result;
}

async function collectVlanTopology(adapter) {
  const [router, server, client] = await Promise.all([101, 104, 106].map((vmid) => adapter.execute(`qm config ${vmid}`)));
  return { router: parseVmNics(router), server: parseVmNics(server), client: parseVmNics(client) };
}

function remoteNetworks(router) {
  if (!router.tunnel) return [];
  return router.interfaces
    .filter((entry) => entry.name !== router.tunnel.name && entry.address !== router.tunnel.source)
    .map((entry) => networkCidr(entry.address, entry.prefix))
    .filter(Boolean);
}

function routeCoverage(routeNetworks, expectedNetworks) {
  const missing = expectedNetworks.filter((network) => !routeNetworks.includes(network));
  return { valid: expectedNetworks.length > 0 && missing.length === 0, missing };
}

export async function applyEcoRouterRoutingChecks(assessment, adapter, serial, report = () => {}) {
  const byVmid = new Map(assessment.devices.map((device) => [device.vmid, device]));
  const startedAt = performance.now();
  const duration = () => Math.max(1, Math.round(performance.now() - startedAt));
  const [routerEntries, vlanTopology] = await Promise.all([
    Promise.all(routerVmids.map(async (vmid) => [vmid, await collectRouter(vmid, adapter, serial, report)])),
    collectVlanTopology(adapter).catch((error) => ({ error: errorSummary(error) }))
  ]);
  const routers = new Map(routerEntries);
  const hq = routers.get(101);
  const br = routers.get(102);

  const hqDevice = byVmid.get(101);
  const vlanCheck = upsertCheck(hqDevice, "hq-interfaces", {
    title: "VLAN 100/200/999 на одном порту",
    maxScore: 5,
    method: "EcoRouter CLI + Proxmox",
    expected: "HQ-SRV=VLAN100 · HQ-CLI=VLAN200 · VLAN999 · единый trunk-порт"
  });
  if (hq.error || vlanTopology.error) {
    setResult(vlanCheck, "unknown", `Данные недоступны · ${hq.error || vlanTopology.error}`, duration());
  } else {
    const trunk = parseVlanTrunks(hq.config).find((port) => [100, 200, 999].every((vlan) => port.services.some((service) => service.vlan === vlan)));
    const serverNic = vlanTopology.server.find((nic) => nic.tag === 100);
    const clientNic = vlanTopology.client.find((nic) => nic.tag === 200);
    const sameBridge = Boolean(serverNic && clientNic && serverNic.bridge === clientNic.bridge);
    const routerNic = sameBridge && vlanTopology.router.some((nic) => nic.bridge === serverNic.bridge && nic.tag == null);
    const valid = Boolean(trunk && sameBridge && routerNic);
    setResult(vlanCheck, valid ? "pass" : "fail",
      `trunk=${trunk?.name || "не найден"} · VLAN=${trunk ? "100,200,999" : "неполный набор"} · HQ-SRV=${serverNic ? `${serverNic.bridge}/100` : "нет tag 100"} · HQ-CLI=${clientNic ? `${clientNic.bridge}/200` : "нет tag 200"} · один NIC HQ-RTR=${routerNic ? "да" : "нет"}`, duration());
  }
  reportResult(report, hqDevice, vlanCheck);

  for (const rule of [
    { vmid: 104, id: "hqsrv-vlan-tag", vlan: 100 },
    { vmid: 106, id: "cli-vlan-tag", vlan: 200 }
  ]) {
    const device = byVmid.get(rule.vmid);
    const check = upsertCheck(device, rule.id, {
      title: `Тег VLAN ${rule.vlan} в Proxmox`,
      maxScore: 1,
      method: `qm config ${rule.vmid}`,
      expected: `Виртуальный NIC: tag=${rule.vlan} · общий bridge с trunk-портом HQ-RTR`
    });
    if (vlanTopology.error) {
      setResult(check, "unknown", `Конфигурация Proxmox недоступна · ${vlanTopology.error}`, duration());
    } else {
      const deviceNics = rule.vmid === 104 ? vlanTopology.server : vlanTopology.client;
      const taggedNic = deviceNics.find((nic) => nic.tag === rule.vlan);
      const routerOnBridge = Boolean(taggedNic && vlanTopology.router.some((nic) => nic.bridge === taggedNic.bridge && nic.tag == null));
      const valid = Boolean(taggedNic && routerOnBridge);
      setResult(check, valid ? "pass" : "fail",
        taggedNic
          ? `qm config ${rule.vmid}: bridge=${taggedNic.bridge} · tag=${taggedNic.tag} · HQ-RTR на том же bridge=${routerOnBridge ? "да" : "нет"}`
          : `qm config ${rule.vmid}: NIC с tag=${rule.vlan} не найден`, duration());
    }
    reportResult(report, device, check);
  }

  const tunnelPair = pairTunnels(hq.tunnel, br.tunnel, hq.interfaces, br.interfaces);
  for (const [vmid, router, peer] of [[101, hq, br], [102, br, hq]]) {
    const device = byVmid.get(vmid);
    const prefix = vmid === 101 ? "hq" : "br";
    const check = upsertCheck(device, `${prefix}-tunnel`, {
      title: "Туннель HQ ↔ BR",
      maxScore: 2,
      method: "EcoRouter serial CLI",
      expected: "GRE или IP-in-IP · адреса в одной p2p-сети · интерфейсы up"
    });
    if (router.error || peer.error) setResult(check, "unknown", `Serial CLI недоступен · ${router.error || peer.error}`, duration());
    else setResult(check, tunnelPair.valid ? "pass" : "fail", tunnelPair.reason, duration());
    reportResult(report, device, check);
  }

  const hqExpectedAtBr = remoteNetworks(hq);
  const brExpectedAtHq = remoteNetworks(br);
  const coverageAtHq = routeCoverage(hq.ospf?.routeNetworks || [], brExpectedAtHq);
  const coverageAtBr = routeCoverage(br.ospf?.routeNetworks || [], hqExpectedAtBr);

  for (const [vmid, router, coverage] of [[101, hq, coverageAtHq], [102, br, coverageAtBr]]) {
    const device = byVmid.get(vmid);
    const prefix = vmid === 101 ? "hq" : "br";
    const check = upsertCheck(device, `${prefix}-ospf`, {
      title: "OSPF через туннель с аутентификацией",
      maxScore: vmid === 101 ? 4 : 3,
      method: "EcoRouter CLI + таблица маршрутизации",
      expected: "passive-interface default · активен только tunnel · MD5 · 1 сосед FULL · сети удалённого офиса"
    });
    if (router.error) {
      setResult(check, "unknown", `Serial CLI недоступен · ${router.error}`, duration());
    } else {
      const state = router.ospf;
      const auth = Boolean(router.tunnel?.auth && router.tunnel?.authKey);
      const valid = state.configured && state.passiveDefault && state.onlyTunnelActive && auth
        && state.fullCount === 1 && state.neighborOnTunnel && coverage.valid;
      setResult(check, valid ? "pass" : "fail",
        `passive-default=${state.passiveDefault ? "да" : "нет"} · только ${router.tunnel?.name || "tunnel"}=${state.onlyTunnelActive ? "да" : "нет"} · MD5=${auth ? "да" : "нет"} · FULL=${state.fullCount} · маршруты=${coverage.valid ? "все" : `нет ${coverage.missing.join(", ") || "удалённых сетей"}`}`, duration());
    }
    reportResult(report, device, check);
  }

  const brRoutesCheck = upsertCheck(byVmid.get(102), "br-routes", {
    title: "Маршруты до сетей HQ",
    maxScore: 4,
    method: "show ip route ospf",
    expected: "Все подключённые сети HQ получены через OSPF"
  });
  if (br.error) setResult(brRoutesCheck, "unknown", `Serial CLI недоступен · ${br.error}`, duration());
  else setResult(brRoutesCheck, coverageAtBr.valid ? "pass" : "fail",
    `получено=${br.ospf.routeNetworks.join(", ") || "нет"} · ${coverageAtBr.valid ? "все сети HQ присутствуют" : `отсутствуют: ${coverageAtBr.missing.join(", ")}`}`, duration());
  reportResult(report, byVmid.get(102), brRoutesCheck);
}

