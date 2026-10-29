import { ipv4Addresses, parseEcoRouterInterfaces, sameSubnet } from "./basic-network.js";

const names = [
  "hq-rtr.au-team.irpo",
  "br-rtr.au-team.irpo",
  "hq-srv.au-team.irpo",
  "hq-cli.au-team.irpo",
  "br-srv.au-team.irpo",
  "docker.au-team.irpo",
  "web.au-team.irpo"
];

function outputOf(result) {
  return `${result["out-data"] || ""}${result["err-data"] || ""}`;
}

function errorSummary(error) {
  return String(error.stderr || error.message || error).trim().split(/\r?\n/)[0].slice(0, 300);
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

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function equalSets(left, right) {
  const a = unique(left);
  const b = unique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function parseHostQueries(output) {
  const records = { a: new Map(), ptr: new Map(), toolMissing: /TOOL_MISSING/.test(output) };
  for (const block of output.split(/^BEGIN_/m).slice(1)) {
    const header = block.match(/^(A|PTR)\|([^\r\n]+)/);
    if (!header) continue;
    const body = block.split(/^END\s*$/m)[0];
    if (header[1] === "A") {
      records.a.set(header[2], unique([...body.matchAll(/\bhas address\s+(\d+(?:\.\d+){3})\b/gi)].map((match) => match[1])));
    } else {
      records.ptr.set(header[2], unique([...body.matchAll(/\bdomain name pointer\s+(\S+)/gi)].map((match) => match[1].replace(/\.$/, "").toLowerCase())));
    }
  }
  return records;
}

function buildQueryScript(expected, dnsServer = null) {
  const serverArgument = dnsServer ? ` ${dnsServer}` : "";
  const lines = [
    "command -v host >/dev/null 2>&1 || { echo TOOL_MISSING; exit 0; }",
    "tmp=$(mktemp -d /tmp/web-demo-dns.XXXXXX) || exit 1",
    "i=0"
  ];
  const query = (header, command) => {
    lines.push(`i=$((i+1)); (echo '${header}'; ${command} 2>&1 || true; echo END) > \"$tmp/$(printf '%03d' $i)\" &`);
  };
  for (const name of names) {
    query(`BEGIN_A|${name}`, `host -W 2 -t A '${name}'${serverArgument}`);
  }
  for (const address of expected.ptr.keys()) {
    query(`BEGIN_PTR|${address}`, `host -W 2 '${address}'${serverArgument}`);
  }
  lines.push("wait", "for file in \"$tmp\"/*; do cat \"$file\"; done", "case \"$tmp\" in /tmp/web-demo-dns.*) rm -rf -- \"$tmp\";; esac");
  return lines.join("; ");
}

function evaluate(records, expected) {
  const failedA = [];
  const failedPtr = [];
  let passedA = 0;
  let passedPtr = 0;
  for (const name of names) {
    const wanted = expected.a.get(name) || [];
    const actual = records.a.get(name) || [];
    if (wanted.length && equalSets(actual, wanted)) passedA += 1;
    else failedA.push(`${name}=${actual.join(",") || "нет"}`);
  }
  for (const [address, wanted] of expected.ptr) {
    const actual = records.ptr.get(address) || [];
    if (equalSets(actual, [wanted])) passedPtr += 1;
    else failedPtr.push(`${address}=${actual.join(",") || "нет"}`);
  }
  return {
    valid: !records.toolMissing && failedA.length === 0 && failedPtr.length === 0,
    passedA,
    passedPtr,
    failedA,
    failedPtr,
    totalA: names.length,
    totalPtr: expected.ptr.size
  };
}

async function collectInventory(adapter, serial, report) {
  const linux = new Map(await Promise.all([100, 104, 105, 106].map(async (vmid) => {
    report({ kind: "command", vmid, command: `qm guest cmd ${vmid} network-get-interfaces`, message: `Читаем адреса для DNS на VM ${vmid}` });
    return [vmid, ipv4Addresses(await adapter.guestCommand(vmid, "network-get-interfaces"))];
  })));
  const routers = new Map(await Promise.all([101, 102].map(async (vmid) => {
    const credentials = await adapter.vmConsoleCredentials(vmid);
    return [vmid, parseEcoRouterInterfaces(await serial.getIpInterfaceBrief(vmid, credentials))];
  })));
  return { linux, routers };
}

function buildExpected(inventory) {
  const isp = inventory.linux.get(100) || [];
  const hqServer = inventory.linux.get(104) || [];
  const brServer = inventory.linux.get(105) || [];
  const hqClient = inventory.linux.get(106) || [];
  const hqRouter = inventory.routers.get(101) || [];
  const brRouter = inventory.routers.get(102) || [];
  const ispHq = isp.find((entry) => entry.name === "ens20");
  const ispBr = isp.find((entry) => entry.name === "ens21");
  const hqOffice = hqRouter.filter((entry) => [27, 24, 29].includes(entry.prefix));
  const brOffice = brRouter.filter((entry) => entry.prefix !== 31 && !(ispBr && entry.prefix === ispBr.prefix && sameSubnet(entry.address, ispBr.address, entry.prefix)));
  const hqServerAddresses = hqServer.filter((entry) => entry.prefix === 27);
  const hqClientAddresses = hqClient.filter((entry) => entry.prefix === 24);
  const brServerAddresses = brServer.filter((entry) => !entry.address.startsWith("127."));
  const a = new Map([
    [names[0], hqOffice.map((entry) => entry.address)],
    [names[1], brOffice.map((entry) => entry.address)],
    [names[2], hqServerAddresses.map((entry) => entry.address)],
    [names[3], hqClientAddresses.map((entry) => entry.address)],
    [names[4], brServerAddresses.map((entry) => entry.address)],
    [names[5], ispHq ? [ispHq.address] : []],
    [names[6], ispBr ? [ispBr.address] : []]
  ]);
  const ptr = new Map();
  for (const entry of hqOffice) ptr.set(entry.address, names[0]);
  for (const entry of hqServerAddresses) ptr.set(entry.address, names[2]);
  for (const entry of hqClientAddresses) ptr.set(entry.address, names[3]);
  return { a, ptr, dnsServer: hqServerAddresses[0]?.address || null };
}

export async function applyDnsChecks(assessment, adapter, serial, report = () => {}) {
  const byVmid = new Map(assessment.devices.map((device) => [device.vmid, device]));
  const startedAt = performance.now();
  let explicit = null;
  let system = null;
  let expected = null;
  let error = null;
  try {
    const inventory = await collectInventory(adapter, serial, report);
    expected = buildExpected(inventory);
    if (!expected.dnsServer) throw new Error("IPv4 HQ-SRV для DNS не найден");
    report({ kind: "command", vmid: 106, command: `host <имя> ${expected.dnsServer}`, message: "Проверяем A/PTR напрямую на DNS HQ-SRV" });
    explicit = parseHostQueries(outputOf(await adapter.guestExec(106, "/bin/sh", ["-lc", buildQueryScript(expected, expected.dnsServer)])));
    report({ kind: "command", vmid: 106, command: "host <имя>", message: "Проверяем A/PTR через системный resolver HQ-CLI" });
    system = parseHostQueries(outputOf(await adapter.guestExec(106, "/bin/sh", ["-lc", buildQueryScript(expected)])));
  } catch (caught) {
    error = errorSummary(caught);
  }
  const duration = Math.max(1, Math.round(performance.now() - startedAt));
  for (const rule of [
    { vmid: 104, id: "hqsrv-dns", title: "DNS-зоны A и PTR", records: explicit, method: "Запросы напрямую к HQ-SRV" },
    { vmid: 106, id: "cli-dns", title: "Разрешение внутренних имён", records: system, method: "Системный resolver HQ-CLI" }
  ]) {
    const device = byVmid.get(rule.vmid);
    const check = upsertCheck(device, rule.id, {
      title: rule.title,
      maxScore: 4,
      method: rule.method,
      expected: "7 записей A · PTR для HQ-RTR, HQ-SRV и HQ-CLI"
    });
    if (error) {
      setResult(check, "unknown", `DNS-проверка недоступна · ${error}`, duration);
    } else {
      const result = evaluate(rule.records, expected);
      const failures = [...result.failedA, ...result.failedPtr];
      setResult(check, result.valid ? "pass" : "fail",
        `A=${result.passedA}/${result.totalA} · PTR=${result.passedPtr}/${result.totalPtr}${rule.records.toolMissing ? " · утилита host не найдена" : ""}${failures.length ? ` · ошибки: ${failures.slice(0, 4).join("; ")}` : ""}`, duration);
    }
    reportResult(report, device, check);
  }
}

