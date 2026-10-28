const linuxRules = [
  { vmid: 100, anyIpv4: true },
  { vmid: 104, address: "192.168.100.2", prefix: 27, gateway: "192.168.100.1" },
  { vmid: 105, address: "192.168.0.2", prefix: 28, gateway: "192.168.0.1" },
  { vmid: 106, address: "192.168.200.2", prefix: 24, gateway: "192.168.200.1" }
];

const ecoRouterRules = [
  { vmid: 101, id: "hq-wan-ipv4", title: "WAN IPv4", cidr: "172.16.1.2/28" },
  { vmid: 101, id: "hq-vlan100-ipv4", title: "VLAN 100 · HQ-SRV", cidr: "192.168.100.1/27" },
  { vmid: 101, id: "hq-vlan200-ipv4", title: "VLAN 200 · HQ-CLI", cidr: "192.168.200.1/24" },
  { vmid: 101, id: "hq-vlan999-ipv4", title: "VLAN 999 · управление", cidr: "192.168.99.1/29" },
  { vmid: 102, id: "br-wan-ipv4", title: "WAN IPv4", cidr: "172.16.2.2/28" },
  { vmid: 102, id: "br-lan-ipv4", title: "LAN BR-SRV", cidr: "192.168.0.1/28" }
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

function setResult(check, passed, evidence, duration) {
  Object.assign(check, {
    status: passed ? "pass" : "fail",
    score: passed ? 1 : 0,
    source: "live",
    duration,
    evidence
  });
}

export async function applyLinuxNetworkChecks(assessment, adapter) {
  await Promise.all(linuxRules.map(async (rule) => {
    const device = assessment.devices.find((item) => item.vmid === rule.vmid);
    if (!device) return;

    const addressId = rule.anyIpv4 ? "isp-ipv4" : `${device.id}-ipv4`;
    const addressCheck = upsertCheck(device, addressId, {
      title: rule.anyIpv4 ? "IPv4 настроен" : "IPv4 и префикс",
      method: "QEMU Guest Agent",
      expected: rule.anyIpv4 ? "любой IPv4, кроме loopback" : `${rule.address}/${rule.prefix}`
    });
    const gatewayCheck = rule.gateway ? upsertCheck(device, `${device.id}-gateway`, {
      title: "Шлюз по умолчанию",
      method: "QEMU Guest Agent",
      expected: rule.gateway
    }) : null;

    if (device.state !== "running") {
      for (const check of [addressCheck, gatewayCheck].filter(Boolean)) {
        Object.assign(check, { status: "unknown", score: 0, source: "unavailable", duration: null, evidence: "VM остановлена" });
      }
      return;
    }

    const startedAt = performance.now();
    try {
      const interfaces = await adapter.guestCommand(rule.vmid, "network-get-interfaces");
      const addresses = ipv4Addresses(interfaces);
      const addressPassed = rule.anyIpv4
        ? addresses.length > 0
        : addresses.some((entry) => entry.address === rule.address && entry.prefix === rule.prefix);
      const rendered = addresses.length
        ? addresses.map((entry) => `${entry.name}:${entry.address}/${entry.prefix}`).join(", ")
        : "не найден";
      setResult(addressCheck, addressPassed, `ожидается=${addressCheck.expected} · получено=${rendered}`, Math.max(1, Math.round(performance.now() - startedAt)));

      if (gatewayCheck) {
        const route = await adapter.guestExec(rule.vmid, "/usr/sbin/ip", ["-4", "route", "show", "default"]);
        const actualGateway = routeGateway(route);
        setResult(gatewayCheck, actualGateway === rule.gateway, `ожидается=${rule.gateway} · получено=${actualGateway || "не найден"}`, Math.max(1, Math.round(performance.now() - startedAt)));
      }
    } catch (error) {
      for (const check of [addressCheck, gatewayCheck].filter(Boolean)) {
        Object.assign(check, {
          status: "unknown", score: 0, source: "unavailable",
          duration: Math.max(1, Math.round(performance.now() - startedAt)),
          evidence: `Канал QGA недоступен · ${errorSummary(error)}`
        });
      }
    }
  }));
}

export async function applyEcoRouterNetworkChecks(assessment, proxmox, serial) {
  for (const vmid of [101, 102]) {
    const device = assessment.devices.find((item) => item.vmid === vmid);
    if (!device) continue;
    const rules = ecoRouterRules.filter((rule) => rule.vmid === vmid);
    const checks = rules.map((rule) => upsertCheck(device, rule.id, {
      title: rule.title,
      method: "EcoRouter serial CLI",
      expected: rule.cidr
    }));

    if (device.state !== "running") {
      checks.forEach((check) => Object.assign(check, { status: "unknown", score: 0, source: "unavailable", duration: null, evidence: "VM остановлена" }));
      continue;
    }

    const startedAt = performance.now();
    try {
      const credentials = await proxmox.vmConsoleCredentials(vmid);
      const output = await serial.getIpInterfaceBrief(vmid, credentials);
      for (let index = 0; index < rules.length; index += 1) {
        const expected = rules[index].cidr;
        const passed = output.includes(expected);
        setResult(checks[index], passed, `ожидается=${expected} · ${passed ? "адрес найден" : "адрес не найден"}`, Math.max(1, Math.round(performance.now() - startedAt)));
      }
    } catch (error) {
      checks.forEach((check) => Object.assign(check, {
        status: "unknown", score: 0, source: "unavailable",
        duration: Math.max(1, Math.round(performance.now() - startedAt)),
        evidence: `Serial CLI недоступен · ${errorSummary(error)}`
      }));
    }
  }
}

export { ecoRouterRules, ipv4Addresses, routeGateway };
