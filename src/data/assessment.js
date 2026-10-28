const checkedAt = () => new Date(Date.now() - 4 * 60 * 1000).toISOString();

export const assessment = {
  lab: {
    id: "de-27-alt-ideco",
    title: "Демоэкзамен — стенд 27",
    subtitle: "Модуль 1 · Сетевая инфраструктура",
    mode: "mock",
    startedAt: "2026-10-28T05:30:00.000Z",
    checkedAt: checkedAt()
  },
  devices: [
    {
      id: "isp", vmid: 100, name: "ISP", role: "Провайдер", type: "linux", color: "#e8ab4c", state: "running",
      score: 8, maxScore: 8,
      checks: [
        { id: "isp-hostname", title: "Имя узла", status: "pass", score: 2, maxScore: 2, method: "QEMU Agent", evidence: "hostnamectl → ISP", duration: 148 },
        { id: "isp-routing", title: "Маршрутизация включена", status: "pass", score: 3, maxScore: 3, method: "QEMU Agent", evidence: "net.ipv4.ip_forward = 1", duration: 176 },
        { id: "isp-uplinks", title: "Линии HQ и BR доступны", status: "pass", score: 3, maxScore: 3, method: "Network probe", evidence: "2/2 ICMP probes succeeded", duration: 812 }
      ]
    },
    {
      id: "hq-rtr", vmid: 101, name: "HQ-RTR", role: "Маршрутизатор головного офиса", type: "router", color: "#36a3b7", state: "running",
      score: 15, maxScore: 19,
      checks: [
        { id: "hq-hostname", title: "Имя и доменное имя", status: "pass", score: 2, maxScore: 2, method: "EcoRouter CLI", evidence: "show hostname → hq-rtr.au-team.irpo", duration: 233 },
        { id: "hq-interfaces", title: "Адреса интерфейсов", status: "pass", score: 5, maxScore: 5, method: "EcoRouter CLI", evidence: "3/3 интерфейса up/up, адреса соответствуют заданию", duration: 361 },
        { id: "hq-ospf", title: "OSPF-соседство с BR-RTR", status: "fail", score: 0, maxScore: 4, method: "CLI + probe", evidence: "Сосед 172.16.4.2 находится в состоянии INIT", duration: 1234 },
        { id: "hq-nat", title: "Доступ пользователей в интернет", status: "pass", score: 4, maxScore: 4, method: "Network probe", evidence: "HTTP 204 через HQ-CLI, исходящий адрес 172.16.1.2", duration: 936 },
        { id: "hq-ssh", title: "Защищённое администрирование", status: "pass", score: 4, maxScore: 4, method: "Port probe", evidence: "SSH доступен из management, Telnet закрыт", duration: 417 }
      ]
    },
    {
      id: "br-rtr", vmid: 102, name: "BR-RTR", role: "Маршрутизатор филиала", type: "router", color: "#8a7564", state: "running",
      score: 12, maxScore: 17,
      checks: [
        { id: "br-hostname", title: "Имя и доменное имя", status: "pass", score: 2, maxScore: 2, method: "EcoRouter CLI", evidence: "show hostname → br-rtr.au-team.irpo", duration: 219 },
        { id: "br-interfaces", title: "Адреса интерфейсов", status: "warning", score: 3, maxScore: 5, method: "EcoRouter CLI", evidence: "e1 и e2 настроены; e3 administratively down", duration: 403 },
        { id: "br-ospf", title: "OSPF-соседство с HQ-RTR", status: "fail", score: 0, maxScore: 3, method: "CLI + probe", evidence: "Соседство не перешло в FULL", duration: 1203 },
        { id: "br-routes", title: "Маршруты до сетей HQ", status: "pass", score: 4, maxScore: 4, method: "EcoRouter CLI", evidence: "Найдены 3/3 требуемых маршрута", duration: 312 },
        { id: "br-save", title: "Конфигурация сохранена", status: "pass", score: 3, maxScore: 3, method: "EcoRouter CLI", evidence: "startup-config соответствует running-config", duration: 287 }
      ]
    },
    {
      id: "br-fw", vmid: 103, name: "BR-FW", role: "Ideco NGFW", type: "firewall", color: "#c9bec2", state: "running",
      score: 10, maxScore: 18,
      checks: [
        { id: "fw-running", title: "Службы межсетевого экрана", status: "pass", score: 3, maxScore: 3, method: "SSH diagnostics", evidence: "ideco-firewall-backend: active", duration: 582 },
        { id: "fw-policy", title: "Политики доступа", status: "warning", score: 3, maxScore: 6, method: "Network probe", evidence: "Разрешённые проверки: 4/5; запрещённые: 3/4", duration: 2186 },
        { id: "fw-nat", title: "Трансляция адресов", status: "pass", score: 4, maxScore: 4, method: "Network probe", evidence: "SNAT подтверждён с BR-SRV", duration: 1034 },
        { id: "fw-admin", title: "Ограничение панели управления", status: "fail", score: 0, maxScore: 5, method: "Port probe", evidence: "TCP/8443 доступен из пользовательского сегмента", duration: 621 }
      ]
    },
    {
      id: "hq-srv", vmid: 104, name: "HQ-SRV", role: "Сервер головного офиса", type: "server", color: "#5c9d7c", state: "running",
      score: 14, maxScore: 14,
      checks: [
        { id: "hqsrv-agent", title: "QEMU Guest Agent", status: "pass", score: 2, maxScore: 2, method: "Proxmox API", evidence: "guest-ping: OK", duration: 92 },
        { id: "hqsrv-hostname", title: "Имя и адресация", status: "pass", score: 3, maxScore: 3, method: "QEMU Agent", evidence: "hq-srv.au-team.irpo · 192.168.10.10/27", duration: 157 },
        { id: "hqsrv-dns", title: "DNS-служба", status: "pass", score: 4, maxScore: 4, method: "DNS probe", evidence: "6/6 записей разрешены корректно", duration: 704 },
        { id: "hqsrv-services", title: "Обязательные службы", status: "pass", score: 5, maxScore: 5, method: "QEMU Agent", evidence: "chronyd, sshd, bind9: active", duration: 203 }
      ]
    },
    {
      id: "br-srv", vmid: 105, name: "BR-SRV", role: "Сервер филиала", type: "server", color: "#826cc0", state: "running",
      score: 9, maxScore: 12,
      checks: [
        { id: "brsrv-agent", title: "QEMU Guest Agent", status: "pass", score: 2, maxScore: 2, method: "Proxmox API", evidence: "guest-ping: OK", duration: 88 },
        { id: "brsrv-address", title: "Имя и адресация", status: "pass", score: 3, maxScore: 3, method: "QEMU Agent", evidence: "br-srv.au-team.irpo · 192.168.20.10/28", duration: 161 },
        { id: "brsrv-time", title: "Синхронизация времени", status: "fail", score: 0, maxScore: 3, method: "QEMU Agent", evidence: "Смещение времени: 187 секунд", duration: 196 },
        { id: "brsrv-services", title: "Обязательные службы", status: "pass", score: 4, maxScore: 4, method: "QEMU Agent", evidence: "sshd, nginx: active", duration: 192 }
      ]
    },
    {
      id: "hq-cli", vmid: 106, name: "HQ-CLI", role: "Клиентская станция", type: "client", color: "#c46fdd", state: "running",
      score: 12, maxScore: 12,
      checks: [
        { id: "cli-address", title: "Получение сетевых параметров", status: "pass", score: 4, maxScore: 4, method: "QEMU Agent", evidence: "DHCP: адрес, шлюз и DNS соответствуют заданию", duration: 189 },
        { id: "cli-dns", title: "Разрешение внутренних имён", status: "pass", score: 4, maxScore: 4, method: "QEMU Agent", evidence: "hq-srv и br-srv разрешаются", duration: 311 },
        { id: "cli-connectivity", title: "Доступ к обязательным ресурсам", status: "pass", score: 4, maxScore: 4, method: "Network probe", evidence: "4/4 ресурса доступны", duration: 936 }
      ]
    }
  ]
};

export function snapshot() {
  return structuredClone(assessment);
}
