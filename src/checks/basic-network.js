const segmentRules = [
  { key: "hq-wan", vmid: 101, id: "hq-wan-ipv4", title: "WAN ↔ ISP", prefix: 28, peerVmid: 100, peerInterface: "ens20" },
  { key: "hq-vlan100", vmid: 101, id: "hq-vlan100-ipv4", title: "VLAN 100 · HQ-SRV", prefix: 27, peerVmid: 104 },
  { key: "hq-vlan200", vmid: 101, id: "hq-vlan200-ipv4", title: "VLAN 200 · HQ-CLI", prefix: 24, peerVmid: 106 },
  { key: "hq-vlan999", vmid: 101, id: "hq-vlan999-ipv4", title: "VLAN 999 · управление", prefix: 29 },
  { key: "br-wan", vmid: 102, id: "br-wan-ipv4", title: "WAN ↔ ISP", prefix: 28, peerVmid: 100, peerInterface: "ens21" }
];

const linuxRules = [
  { vmid: 104, routerVmid: 101, segmentKey: "hq-vlan100", prefix: 27 },
  { vmid: 106, routerVmid: 101, segmentKey: "hq-vlan200", prefix: 24 }
];

function errorSummary(error) {
  return String(error.stderr || error.message || error).trim().split(/\r?\n/)[0];
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

function ipv4ToInt(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets.reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function prefixMask(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function networkNumber(address, prefix) {
  const value = ipv4ToInt(address);
  return value == null ? null : (value & prefixMask(prefix)) >>> 0;
}

function isPrivateIpv4(address) {
  const value = ipv4ToInt(address);
  if (value == null) return false;
  return (value >= ipv4ToInt("10.0.0.0") && value <= ipv4ToInt("10.255.255.255"))
    || (value >= ipv4ToInt("172.16.0.0") && value <= ipv4ToInt("172.31.255.255"))
    || (value >= ipv4ToInt("192.168.0.0") && value <= ipv4ToInt("192.168.255.255"));
}

function isUsableHost(address, prefix) {
  const value = ipv4ToInt(address);
  const network = networkNumber(address, prefix);
  if (value == null || network == null || prefix > 30) return false;
  const broadcast = (network | (~prefixMask(prefix) >>> 0)) >>> 0;
  return value !== network && value !== broadcast;
}

function sameSubnet(left, right, prefix) {
  return networkNumber(left, prefix) === networkNumber(right, prefix);
}

function rangesOverlap(left, right) {
  if (!left || !right) return false;
  const leftStart = networkNumber(left.address, left.prefix);
  const rightStart = networkNumber(right.address, right.prefix);
  const leftEnd = (leftStart | (~prefixMask(left.prefix) >>> 0)) >>> 0;
  const rightEnd = (rightStart | (~prefixMask(right.prefix) >>> 0)) >>> 0;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function ipv4Addresses(interfaces) {
  return interfaces.flatMap((networkInterface) =>
    (networkInterface["ip-addresses"] || [])
      .filter((entry) => entry["ip-address-type"] === "ipv4" && !entry["ip-address"].startsWith("127."))
      .map((entry) => ({ name: networkInterface.name, address: entry["ip-address"], prefix: entry.prefix }))
  );
}

function routeGateway(execResult) {
  return execResult["out-data"]?.match(/\bdefault\s+via\s+(\d+(?:\.\d+){3})\b/)?.[1] || null;
}

function parseEcoRouterInterfaces(output) {
  const interfaces = [];
  let currentInterface = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const interfaceMatch = line.match(/^interface\s+(\S+)/i);
    if (interfaceMatch) currentInterface = interfaceMatch[1];
    for (const cidr of line.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\b/g)) {
      const firstToken = line.split(/\s+/)[0];
      const name = currentInterface && /^ip\s+address\b/i.test(line) ? currentInterface : firstToken;
      if (!interfaces.some((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.address === cidr[1])) {
        interfaces.push({ name, address: cidr[1], prefix: Number(cidr[2]) });
      }
    }
  }
  return interfaces;
}

function findInterface(observation, name) {
  return observation?.addresses?.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) || null;
}

function findRouterEndpoint(rule, observations) {
  const router = observations.get(rule.vmid);
  if (rule.interface) return findInterface(router, rule.interface);
  if (!rule.peerVmid) {
    return router?.addresses?.find((candidate) => candidate.prefix === rule.prefix && isPrivateIpv4(candidate.address)) || null;
  }
  const peers = observations.get(rule.peerVmid)?.addresses?.filter((candidate) =>
    (!rule.peerInterface || candidate.name.toLowerCase() === rule.peerInterface.toLowerCase())
    && candidate.prefix === rule.prefix
    && isPrivateIpv4(candidate.address)
  ) || [];
  return router?.addresses?.find((candidate) =>
    candidate.prefix === rule.prefix
    && peers.some((peer) => candidate.address !== peer.address && sameSubnet(candidate.address, peer.address, rule.prefix))
  ) || null;
}

function endpointValid(endpoint, prefix) {
  return Boolean(endpoint && endpoint.prefix === prefix && isPrivateIpv4(endpoint.address) && isUsableHost(endpoint.address, prefix));
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

function describeAddresses(observation) {
  if (!observation?.addresses?.length) return "IPv4 не найден";
  return observation.addresses.map((entry) => `${entry.name}:${entry.address}/${entry.prefix}`).join(", ");
}

async function collectLinux(device, adapter, report, includeGateway) {
  const observation = { addresses: [], gateway: null, addressError: null, gatewayError: null };
  if (device.state !== "running") {
    observation.addressError = "VM остановлена";
    observation.gatewayError = "VM остановлена";
    return observation;
  }
  try {
    report({ kind: "command", vmid: device.vmid, device: device.name, command: `qm guest cmd ${device.vmid} network-get-interfaces`, message: `Читаем IPv4-интерфейсы ${device.name}` });
    observation.addresses = ipv4Addresses(await adapter.guestCommand(device.vmid, "network-get-interfaces"));
  } catch (error) {
    observation.addressError = errorSummary(error);
  }
  if (includeGateway) {
    try {
      report({ kind: "command", vmid: device.vmid, device: device.name, command: "/usr/sbin/ip -4 route show default", message: `Проверяем шлюз ${device.name}` });
      observation.gateway = routeGateway(await adapter.guestExec(device.vmid, "/usr/sbin/ip", ["-4", "route", "show", "default"]));
    } catch (error) {
      observation.gatewayError = errorSummary(error);
    }
  }
  return observation;
}

async function collectEcoRouter(device, proxmox, serial, report) {
  const observation = { addresses: [], addressError: null };
  if (device.state !== "running") {
    observation.addressError = "VM остановлена";
    return observation;
  }
  try {
    report({ kind: "command", vmid: device.vmid, device: device.name, command: "show ip interface brief", message: `Читаем адреса ${device.name} через serial CLI` });
    const credentials = await proxmox.vmConsoleCredentials(device.vmid);
    const output = serial.getNetworkConfiguration
      ? await serial.getNetworkConfiguration(device.vmid, credentials)
      : await serial.getIpInterfaceBrief(device.vmid, credentials);
    observation.addresses = parseEcoRouterInterfaces(output);
  } catch (error) {
    observation.addressError = errorSummary(error);
  }
  return observation;
}

export async function applyTopologyNetworkChecks(assessment, adapter, serial, report = () => {}) {
  const byVmid = new Map(assessment.devices.map((device) => [device.vmid, device]));
  const observations = new Map();
  const startedAt = performance.now();

  await Promise.all([100, 104, 106].map(async (vmid) => {
    observations.set(vmid, await collectLinux(byVmid.get(vmid), adapter, report, vmid !== 100));
  }));
  await Promise.all([101, 102].map(async (vmid) => {
    observations.set(vmid, await collectEcoRouter(byVmid.get(vmid), adapter, serial, report));
  }));

  const routerEndpoints = new Map(segmentRules.map((rule) => [rule.key, findRouterEndpoint(rule, observations)]));
  const overlapping = new Set();
  for (let left = 0; left < segmentRules.length; left += 1) {
    for (let right = left + 1; right < segmentRules.length; right += 1) {
      const leftRule = segmentRules[left];
      const rightRule = segmentRules[right];
      const leftEndpoint = routerEndpoints.get(leftRule.key);
      const rightEndpoint = routerEndpoints.get(rightRule.key);
      if (endpointValid(leftEndpoint, leftRule.prefix) && endpointValid(rightEndpoint, rightRule.prefix) && rangesOverlap(leftEndpoint, rightEndpoint)) {
        overlapping.add(leftRule.key);
        overlapping.add(rightRule.key);
      }
    }
  }

  for (const rule of segmentRules) {
    const device = byVmid.get(rule.vmid);
    const observation = observations.get(rule.vmid);
    const check = upsertCheck(device, rule.id, {
      title: rule.title,
      method: "EcoRouter serial CLI + проверка топологии",
      expected: `RFC1918 /${rule.prefix}${rule.peerVmid ? " · один сегмент с соседним устройством" : " · отдельный сегмент"}`
    });
    const endpoint = routerEndpoints.get(rule.key);
    let status = "fail";
    const interfaceLabel = endpoint?.name || rule.interface || "WAN";
    let evidence = `${interfaceLabel}: ${endpoint ? `${endpoint.address}/${endpoint.prefix}` : "адрес не найден"}`;
    if (observation.addressError) {
      status = "unknown";
      evidence = `Serial CLI недоступен · ${observation.addressError}`;
    } else if (!endpointValid(endpoint, rule.prefix)) {
      evidence += ` · требуется частный доступный адрес /${rule.prefix}`;
    } else if (overlapping.has(rule.key)) {
      evidence += " · сеть пересекается с другим сегментом";
    } else if (rule.peerVmid) {
      const peer = observations.get(rule.peerVmid);
      if (peer.addressError) {
        status = "unknown";
        evidence += ` · сосед недоступен: ${peer.addressError}`;
      } else {
        const peerEndpoint = peer.addresses.find((candidate) =>
          (!rule.peerInterface || candidate.name.toLowerCase() === rule.peerInterface.toLowerCase())
          &&
          candidate.prefix === rule.prefix
          && isPrivateIpv4(candidate.address)
          && isUsableHost(candidate.address, rule.prefix)
          && candidate.address !== endpoint.address
          && sameSubnet(candidate.address, endpoint.address, rule.prefix)
        );
        if (peerEndpoint) {
          status = "pass";
          evidence += ` ↔ ${byVmid.get(rule.peerVmid).name}:${peerEndpoint.address}/${peerEndpoint.prefix}`;
        } else {
          evidence += ` · у ${byVmid.get(rule.peerVmid).name} нет второго адреса в этой подсети (${describeAddresses(peer)})`;
        }
      }
    } else {
      status = "pass";
      evidence += " · RFC1918 и маска корректны";
    }
    setResult(check, status, evidence, Math.max(1, Math.round(performance.now() - startedAt)));
    report({ kind: "result", vmid: device.vmid, device: device.name, check: { ...check }, message: `${check.title}: ${status === "pass" ? "выполнено" : status === "fail" ? "ошибка" : "недоступно"} · ${evidence}` });
  }

  for (const rule of linuxRules) {
    const device = byVmid.get(rule.vmid);
    const observation = observations.get(rule.vmid);
    const routerObservation = observations.get(rule.routerVmid);
    const routerEndpoint = routerEndpoints.get(rule.segmentKey);
    const addressCheck = upsertCheck(device, `${device.id}-ipv4`, {
      title: "IPv4 и связь с маршрутизатором",
      method: "QEMU Guest Agent + проверка топологии",
      expected: `RFC1918 /${rule.prefix} · одна подсеть с ${byVmid.get(rule.routerVmid).name}`
    });
    let addressStatus = "fail";
    let endpoint = null;
    let addressEvidence = describeAddresses(observation);
    if (observation.addressError || routerObservation.addressError) {
      addressStatus = "unknown";
      addressEvidence = `Данные недоступны · ${observation.addressError || routerObservation.addressError}`;
    } else if (!endpointValid(routerEndpoint, rule.prefix)) {
      addressEvidence += ` · на ${byVmid.get(rule.routerVmid).name} нет корректного /${rule.prefix} в общей подсети`;
    } else {
      endpoint = observation.addresses.find((candidate) =>
        candidate.prefix === rule.prefix
        && isPrivateIpv4(candidate.address)
        && isUsableHost(candidate.address, rule.prefix)
        && candidate.address !== routerEndpoint.address
        && sameSubnet(candidate.address, routerEndpoint.address, rule.prefix)
      );
      if (endpoint) {
        addressStatus = "pass";
        addressEvidence = `${device.name}:${endpoint.address}/${endpoint.prefix} ↔ ${byVmid.get(rule.routerVmid).name}:${routerEndpoint.address}/${routerEndpoint.prefix}`;
      } else {
        addressEvidence += " · нет адреса в общей подсети с маршрутизатором";
      }
    }
    setResult(addressCheck, addressStatus, addressEvidence, Math.max(1, Math.round(performance.now() - startedAt)));
    report({ kind: "result", vmid: device.vmid, device: device.name, check: { ...addressCheck }, message: `${addressCheck.title}: ${addressStatus === "pass" ? "выполнено" : addressStatus === "fail" ? "ошибка" : "недоступно"} · ${addressEvidence}` });

    const gatewayCheck = upsertCheck(device, `${device.id}-gateway`, {
      title: "Шлюз по умолчанию",
      method: "QEMU Guest Agent + проверка топологии",
      expected: `адрес ${byVmid.get(rule.routerVmid).name} в той же подсети`
    });
    let gatewayStatus = "fail";
    let gatewayEvidence = `получено=${observation.gateway || "не найден"}`;
    if (observation.gatewayError || routerObservation.addressError) {
      gatewayStatus = "unknown";
      gatewayEvidence = `Данные недоступны · ${observation.gatewayError || routerObservation.addressError}`;
    } else if (routerEndpoint && observation.gateway === routerEndpoint.address && endpoint && sameSubnet(observation.gateway, endpoint.address, rule.prefix)) {
      gatewayStatus = "pass";
      gatewayEvidence = `шлюз=${observation.gateway} · совпадает с ${byVmid.get(rule.routerVmid).name}:${routerEndpoint.name}`;
    } else {
      gatewayEvidence += ` · адрес маршрутизатора=${routerEndpoint?.address || "не найден"}`;
    }
    setResult(gatewayCheck, gatewayStatus, gatewayEvidence, Math.max(1, Math.round(performance.now() - startedAt)));
    report({ kind: "result", vmid: device.vmid, device: device.name, check: { ...gatewayCheck }, message: `${gatewayCheck.title}: ${gatewayStatus === "pass" ? "выполнено" : gatewayStatus === "fail" ? "ошибка" : "недоступно"} · ${gatewayEvidence}` });
  }
}

export { ipv4Addresses, routeGateway, parseEcoRouterInterfaces, isPrivateIpv4, isUsableHost, sameSubnet, rangesOverlap };
