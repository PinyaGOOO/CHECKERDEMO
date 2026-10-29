const positions = { internet:[600,73], isp:[600,205], hqrtr:[350,335], brrtr:[850,335], hqsrv:[235,540], hqcli:[465,540], brfw:[735,540], brsrv:[965,540] };
const labels = { internet:"Интернет", isp:"ISP", hqrtr:"HQ-RTR", brrtr:"BR-RTR", hqsrv:"HQ-SRV", hqcli:"HQ-CLI", brfw:"BR-FW", brsrv:"BR-SRV" };
const vmNodes = new Map([[100,"isp"],[101,"hqrtr"],[102,"brrtr"],[103,"brfw"],[104,"hqsrv"],[105,"brsrv"],[106,"hqcli"]]);
const bridgeMembers = {
  vmbr0:["isp","internet"], ISP_HQ:["isp","hqrtr"], ISP_BR:["isp","brrtr"],
  HQ_NET:["hqrtr","hqsrv","hqcli"], FW_NET:["brrtr","brfw"], BR_NET:["brfw","brsrv"]
};
const bridgeLinks = {
  vmbr0:["internet-isp"], ISP_HQ:["isp-hqrtr"], ISP_BR:["isp-brrtr"],
  HQ_NET:["hqrtr-hqsrv","hqrtr-hqcli"], FW_NET:["brrtr-brfw"], BR_NET:["brrtr-brsrv"]
};
const state = { stream:null, running:false, count:0, packets:[], animationId:null };
const packetLayer = document.querySelector("#packet-layer");
const toggleButton = document.querySelector("#toggle-button");
const badge = document.querySelector("#capture-badge");

function protocolClass(protocol) {
  return ({ TCP:"tcp", UDP:"udp", ICMP:"icmp", ARP:"arp", IPv6:"ipv6" })[protocol] || "ipv4";
}

function filtered(packet) {
  const selected = document.querySelector("#protocol-select").value;
  return selected !== "ALL" && packet.protocol !== selected;
}

function setCaptureState(status, detail) {
  state.running = status === "running";
  badge.textContent = status === "running" ? "Live capture" : status === "starting" ? "Подключение…" : "Захват остановлен";
  badge.classList.toggle("live", status === "running");
  toggleButton.textContent = state.running || status === "starting" ? "■ Остановить захват" : "▶ Начать захват";
  document.querySelector("#current-step").textContent = detail || (state.running ? "Ожидаем пакеты…" : "Захват остановлен");
}

function nodeForDevice(device) {
  return device ? vmNodes.get(device.vmid) || null : null;
}

function packetRoutes(packet) {
  const members = bridgeMembers[packet.bridge] || [];
  const source = nodeForDevice(packet.srcDevice);
  const destination = nodeForDevice(packet.dstDevice);
  if (source && destination && source !== destination) return [[source, destination]];
  if (source) return members.filter((node) => node !== source).map((node) => [source, node]);
  if (destination) return members.filter((node) => node !== destination).map((node) => [node, destination]);
  return members.length >= 2 ? [[members[0], members[1]]] : [];
}

function highlightBridge(bridge) {
  const ids = new Set(bridgeLinks[bridge] || []);
  document.querySelectorAll("[data-link]").forEach((link) => link.classList.toggle("active", ids.has(link.dataset.link)));
  clearTimeout(highlightBridge.timer);
  highlightBridge.timer = setTimeout(() => document.querySelectorAll("[data-link]").forEach((link) => link.classList.remove("active")), 360);
}

function spawnVisualPacket(from, to, protocol) {
  if (!positions[from] || !positions[to]) return;
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("r", "7");
  circle.classList.add("packet", protocolClass(protocol));
  packetLayer.append(circle);
  state.packets.push({ circle, from:positions[from], to:positions[to], startedAt:performance.now(), duration:650 });
  if (!state.animationId) state.animationId = requestAnimationFrame(animatePackets);
}

function animatePackets(now) {
  state.packets = state.packets.filter((packet) => {
    const progress = Math.min(1, (now - packet.startedAt) / packet.duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    packet.circle.setAttribute("cx", String(packet.from[0] + (packet.to[0] - packet.from[0]) * eased));
    packet.circle.setAttribute("cy", String(packet.from[1] + (packet.to[1] - packet.from[1]) * eased));
    if (progress >= 1) packet.circle.remove();
    return progress < 1;
  });
  state.animationId = state.packets.length ? requestAnimationFrame(animatePackets) : null;
}

function endpoint(ip, port, device, fallback) {
  const address = ip ? `${ip}${port ? `:${port}` : ""}` : device?.name || fallback;
  return device ? `${device.name} · ${address}` : address;
}

function appendLog(packet) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const title = document.createElement("strong");
  title.textContent = `${endpoint(packet.srcIp, packet.srcPort, packet.srcDevice, packet.srcMac)} → ${endpoint(packet.dstIp, packet.dstPort, packet.dstDevice, packet.dstMac)}`;
  const detail = document.createElement("small");
  detail.textContent = `${packet.protocol} · ${packet.bridge} · ${packet.length || "?"} байт`;
  entry.append(title, detail);
  const log = document.querySelector("#event-log");
  log.prepend(entry);
  while (log.children.length > 30) log.lastElementChild.remove();
}

function handlePacket(packet) {
  if (filtered(packet)) return;
  state.count += 1;
  document.querySelector("#packet-count").textContent = `${state.count} пакетов`;
  const routes = packetRoutes(packet);
  routes.forEach(([from, to]) => spawnVisualPacket(from, to, packet.protocol));
  highlightBridge(packet.bridge);
  appendLog(packet);
  const routeText = routes[0] ? `${labels[routes[0][0]]} → ${labels[routes[0][1]]}` : packet.bridge;
  document.querySelector("#current-step").textContent = `${routeText} · ${packet.protocol} · ${packet.length || "?"} байт`;
}

function startCapture() {
  if (state.stream) return;
  setCaptureState("starting", "Подключаемся к tcpdump на Proxmox…");
  const stream = new EventSource("/api/traffic/events");
  state.stream = stream;
  stream.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "capture-status") setCaptureState(event.status);
    else if (event.type === "packet") handlePacket(event);
    else if (event.type === "capture-error") stopCapture(`Ошибка захвата: ${event.message}`);
  };
  stream.onerror = () => stopCapture("Соединение с потоком пакетов потеряно");
}

function stopCapture(message = "Захват остановлен") {
  state.stream?.close();
  state.stream = null;
  setCaptureState("stopped", message);
}

function clearScreen() {
  state.count = 0;
  document.querySelector("#packet-count").textContent = "0 пакетов";
  document.querySelector("#event-log").innerHTML = "";
  state.packets.forEach((packet) => packet.circle.remove());
  state.packets = [];
}

async function loadVmStates() {
  try {
    const infrastructure = await fetch("/api/infrastructure").then((response) => response.json());
    const statuses = new Map(infrastructure.vms.map((vm) => [String(vm.vmid), vm.status]));
    document.querySelectorAll("[data-vmid]").forEach((node) => node.classList.toggle("offline", statuses.get(node.dataset.vmid) !== "running"));
  } catch { /* Capture can still work without inventory decoration. */ }
}

toggleButton.addEventListener("click", () => state.stream ? stopCapture() : startCapture());
document.querySelector("#clear-button").addEventListener("click", clearScreen);
document.addEventListener("visibilitychange", () => { if (document.hidden) stopCapture("Захват остановлен в фоновой вкладке"); });
window.addEventListener("beforeunload", () => state.stream?.close());
loadVmStates();
