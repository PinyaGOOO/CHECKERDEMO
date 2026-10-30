const definitions = [
  { code: "1.1", maxScore: 2, title: "Маршрутизация и сетевая трансляция адресов на ISP" },
  { code: "1.2", maxScore: 2, title: "IP-адреса и имена устройств" },
  { code: "1.3", maxScore: 2, title: "Разделение на подсети" },
  { code: "1.4", maxScore: 2, title: "Подинтерфейсы HQ-RTR" },
  { code: "1.5", maxScore: 2, title: "DHCP на HQ-RTR" },
  { code: "1.6", maxScore: 2, title: "Туннель HQ-BR" },
  { code: "1.7", maxScore: 2, title: "NAT офисов и выход в Интернет" },
  { code: "1.8", maxScore: 3, title: "Динамическая маршрутизация" },
  { code: "1.9", maxScore: 1, title: "Удалённый доступ HQ-SRV и BR-SRV" },
  { code: "1.10", maxScore: 2, title: "Локальные учётные записи" },
  { code: "1.11", maxScore: 3, title: "DNS: прямые/обратные зоны и пересылка" },
  { code: "1.12", maxScore: 1, title: "Часовой пояс" },
  { code: "1.13", maxScore: 1, title: "Отчёт по ГОСТ Р 7.0.97-2016" }
];

function checkIndex(assessment) {
  return new Map(assessment.devices.flatMap((device) => device.checks.map((check) => [check.id, check])));
}

function statusOf(checks, id) {
  return checks.get(id)?.status || "missing";
}

function allPass(checks, ids) {
  return ids.every((id) => statusOf(checks, id) === "pass");
}

function passCount(checks, ids) {
  return ids.filter((id) => statusOf(checks, id) === "pass").length;
}

function anyUnavailable(checks, ids) {
  return ids.some((id) => ["missing", "unknown"].includes(statusOf(checks, id)));
}

function compactEvidence(checks, ids) {
  return ids.map((id) => `${id}=${statusOf(checks, id)}`).join(" · ");
}

function result(level, evidence, technicalChecks, manual = false) {
  return { level, evidence, technicalChecks, manual };
}

function evaluateCriterion(code, checks) {
  if (code === "1.1") {
    const ids = ["isp-forwarding", "isp-nat", "isp-nat-persistent"];
    if (allPass(checks, ids)) return result(2, "IP forwarding, NAT обеих WAN-сетей и сохранение правил подтверждены", ids);
    const nat = checks.get("isp-nat");
    const oneOffice = (nat?.evidence?.match(/:есть/g) || []).length >= 1;
    if (statusOf(checks, "isp-forwarding") === "pass" && oneOffice) return result(1, `NAT подтверждён только частично · ${compactEvidence(checks, ids)}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, `Маршрутизация/NAT ISP не подтверждены · ${compactEvidence(checks, ids)}`, ids);
  }

  if (code === "1.2") {
    const hostnames = ["isp-hostname", "hq-hostname", "br-hostname", "hqsrv-hostname", "brsrv-hostname", "cli-hostname"];
    const addresses = ["hq-wan-ipv4", "br-wan-ipv4", "hq-vlan100-ipv4", "hq-vlan200-ipv4", "hq-srv-ipv4", "brsrv-ipv4", "hq-cli-ipv4"];
    const ids = [...hostnames, ...addresses];
    if (allPass(checks, ids)) return result(2, "Имена и адреса всех проверяемых устройств корректны; BR-FW исключён из автоматической проверки", ids);
    const correctDevices = [
      statusOf(checks, "isp-hostname") === "pass" && statusOf(checks, "hq-wan-ipv4") === "pass" && statusOf(checks, "br-wan-ipv4") === "pass",
      statusOf(checks, "hq-hostname") === "pass" && ["hq-wan-ipv4", "hq-vlan100-ipv4", "hq-vlan200-ipv4"].every((id) => statusOf(checks, id) === "pass"),
      statusOf(checks, "br-hostname") === "pass" && statusOf(checks, "br-wan-ipv4") === "pass",
      statusOf(checks, "hqsrv-hostname") === "pass" && statusOf(checks, "hq-srv-ipv4") === "pass",
      statusOf(checks, "brsrv-hostname") === "pass" && statusOf(checks, "brsrv-ipv4") === "pass",
      statusOf(checks, "cli-hostname") === "pass" && statusOf(checks, "hq-cli-ipv4") === "pass"
    ].filter(Boolean).length;
    if (correctDevices >= 2) return result(1, `Полностью подтверждено устройств: ${correctDevices}/6 · BR-FW не оценивается`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · корректных устройств: ${correctDevices}/6`, ids);
    return result(0, `Корректных устройств: ${correctDevices}/6`, ids);
  }

  if (code === "1.3") {
    const ids = ["hq-wan-ipv4", "br-wan-ipv4", "hq-vlan100-ipv4", "hq-vlan200-ipv4", "hq-vlan999-ipv4", "brsrv-ipv4"];
    const passed = passCount(checks, ids);
    if (passed === ids.length) return result(2, `Все ${ids.length} проверяемых подсетей рассчитаны верно`, ids);
    if (passed >= 2) return result(1, `Корректных подсетей: ${passed}/${ids.length}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · корректных подсетей: ${passed}/${ids.length}`, ids);
    return result(0, `Корректных подсетей: ${passed}/${ids.length}`, ids);
  }

  if (code === "1.4") {
    const ids = ["hq-interfaces", "hq-vlan100-ipv4", "hq-vlan200-ipv4", "hq-vlan999-ipv4"];
    const passed = passCount(checks, ids);
    if (passed === ids.length) return result(2, "Trunk и подинтерфейсы VLAN 100/200/999 настроены", ids);
    if (passed > 0) return result(1, `Настроено проверок интерфейсов: ${passed}/${ids.length}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, "Подинтерфейсы HQ-RTR не подтверждены", ids);
  }

  if (code === "1.5") {
    const ids = ["hq-dhcp-server", "cli-address", "cli-domain-search"];
    if (allPass(checks, ids)) return result(2, "DHCP-сервер и параметры клиента полностью соответствуют заданию", ids);
    const server = checks.get("hq-dhcp-server");
    const configured = server && !/server=не найден/i.test(server.evidence || "");
    if (configured) return result(1, `DHCP настроен, но параметры содержат ошибки · ${server.evidence}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, "DHCP-сервер на HQ-RTR не обнаружен", ids);
  }

  if (code === "1.6") {
    const ids = ["hq-tunnel", "br-tunnel"];
    if (allPass(checks, ids)) return result(2, "Туннель HQ-BR настроен с обеих сторон и работает", ids);
    const detected = ids.some((id) => checks.get(id) && !/туннель не найден/i.test(checks.get(id).evidence || ""));
    if (detected) return result(1, `Туннель обнаружен, но работает с ошибками · ${compactEvidence(checks, ids)}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, "Туннель не обнаружен", ids);
  }

  if (code === "1.7") {
    const common = ["isp-forwarding", "isp-nat"];
    const hq = ["hq-srv-internet", "hq-cli-internet"];
    const br = ["br-srv-internet"];
    const routing = ["hq-default-route", "br-default-route"];
    const ids = [...common, ...hq, ...br, ...routing];
    if (allPass(checks, ids)) return result(2, "Выход в Интернет подтверждён из обеих зон HQ и BR", ids);
    const hqWorks = allPass(checks, [...common, ...hq, "hq-default-route"]);
    const brWorks = allPass(checks, [...common, ...br, "br-default-route"]);
    if (hqWorks || brWorks) return result(1, `Выход подтверждён только для зоны ${hqWorks ? "HQ" : "BR"}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, "Выход офисных зон в Интернет не подтверждён", ids);
  }

  if (code === "1.8") {
    const ids = ["hq-ospf", "br-ospf", "br-routes"];
    if (allPass(checks, ids)) return result(2, "OSPF, пассивные интерфейсы, MD5, соседство и удалённые маршруты подтверждены", ids);
    const configured = ids.some((id) => statusOf(checks, id) === "pass" || /passive-default=да|FULL=[1-9]|получено=\d/i.test(checks.get(id)?.evidence || ""));
    if (configured) return result(1, `Динамическая маршрутизация настроена частично · ${compactEvidence(checks, ids)}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, "Динамическая маршрутизация не подтверждена", ids);
  }

  if (code === "1.9") {
    const ids = ["hq-srv-ssh", "br-srv-ssh"];
    if (allPass(checks, ids)) return result(2, "SSH на обоих серверах полностью соответствует заданию", ids);
    const active = ids.filter((id) => /sshd=active/i.test(checks.get(id)?.evidence || "")).length;
    if (active === ids.length) return result(1, `SSH работает на обоих серверах, но параметры отличаются от задания · ${compactEvidence(checks, ids)}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, "Удалённый доступ на двух серверах не подтверждён", ids);
  }

  if (code === "1.10") {
    const ids = ["hq-srv-sshuser", "br-srv-sshuser", "hq-net-admin", "br-net-admin"];
    const passed = passCount(checks, ids);
    if (passed === ids.length) return result(2, "Все требуемые локальные учётные записи настроены", ids);
    if (passed > 0) return result(1, `Корректных учётных записей: ${passed}/${ids.length}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, "Требуемые учётные записи не подтверждены", ids);
  }

  if (code === "1.11") {
    const ids = ["hqsrv-dns", "hqsrv-dns-forwarding"];
    if (allPass(checks, ids)) return result(2, "A/PTR-зоны и пересылка на общедоступный DNS подтверждены", ids);
    const dns = checks.get("hqsrv-dns");
    const answers = dns?.evidence?.match(/A=(\d+)\/\d+.*PTR=(\d+)\/\d+/i);
    const someRecords = answers && Number(answers[1]) + Number(answers[2]) > 0;
    if (someRecords || statusOf(checks, "hqsrv-dns") === "pass") return result(1, `DNS работает, но зоны или пересылка содержат ошибки · ${compactEvidence(checks, ids)}`, ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, "Работа DNS-сервера не подтверждена", ids);
  }

  if (code === "1.12") {
    const linux = ["isp-timezone", "hq-srv-timezone", "brsrv-time", "hq-cli-timezone"];
    const routers = ["hq-timezone", "br-timezone"];
    const ids = [...linux, ...routers];
    if (allPass(checks, ids)) return result(2, "Часовой пояс UTC+5 установлен на всех проверяемых устройствах", ids);
    if (allPass(checks, linux)) return result(1, "Серверы и клиент настроены, но часовой пояс отсутствует хотя бы на одном маршрутизаторе", ids);
    if (anyUnavailable(checks, ids)) return result(null, `Недостаточно данных · ${compactEvidence(checks, ids)}`, ids);
    return result(0, `Часовой пояс настроен не по заданию · ${compactEvidence(checks, ids)}`, ids);
  }

  return result(null, "Требуется ручная проверка предоставленного отчёта", [], true);
}

export function applyOfficialAssessment(assessment) {
  const checks = checkIndex(assessment);
  const criteria = definitions.map((definition) => {
    const evaluation = evaluateCriterion(definition.code, checks);
    const weight = definition.maxScore / 2;
    const score = evaluation.level == null ? 0 : evaluation.level * weight;
    const status = evaluation.level == null ? "unknown" : evaluation.level === 2 ? "pass" : evaluation.level === 1 ? "warning" : "fail";
    return { ...definition, weight, score, status, ...evaluation };
  });
  assessment.official = {
    module: 1,
    title: "Настройка сетевой инфраструктуры",
    score: criteria.reduce((sum, criterion) => sum + criterion.score, 0),
    maxScore: definitions.reduce((sum, criterion) => sum + criterion.maxScore, 0),
    evaluatedCount: criteria.filter((criterion) => criterion.level != null).length,
    criteria
  };
  return assessment;
}

export { definitions as officialCriterionDefinitions };
