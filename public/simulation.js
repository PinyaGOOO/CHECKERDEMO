const scenarios = {
  "hq-internet": {
    protocol: "HTTP",
    description: "HTTP-запрос от HQ-CLI через HQ-RTR и динамический NAT на ISP.",
    path: ["hqcli", "hqrtr", "isp", "internet", "isp", "hqrtr", "hqcli"]
  },
  "hq-dns": {
    protocol: "DNS",
    description: "DNS-запрос проходит между VLAN 200 и VLAN 100 через HQ-RTR.",
    path: ["hqcli", "hqrtr", "hqsrv", "hqrtr", "hqcli"]
  },
  "br-internet": {
    protocol: "HTTP",
    description: "Трафик BR-SRV проходит через BR-RTR и NAT на ISP.",
    path: ["brsrv", "brrtr", "isp", "internet", "isp", "brrtr", "brsrv"]
  },
  "hq-isp": {
    protocol: "ICMP",
    description: "Эхо-запрос проверяет WAN-связь между HQ-RTR и ISP.",
    path: ["hqrtr", "isp", "hqrtr"]
  }
};

const nodeLabels = { internet:"Интернет", isp:"ISP", hqrtr:"HQ-RTR", brrtr:"BR-RTR", hqsrv:"HQ-SRV", hqcli:"HQ-CLI", brfw:"BR-FW", brsrv:"BR-SRV" };
const positions = { internet:[600,73], isp:[600,205], hqrtr:[350,335], brrtr:[850,335], hqsrv:[235,540], hqcli:[465,540], brfw:[735,540], brsrv:[965,540] };
const state = { running:false, speed:1, packets:[], lastSpawn:0, count:0, animationId:null };
const svg = document.querySelector("#topology");
const packetLayer = document.querySelector("#packet-layer");
const toggleButton = document.querySelector("#toggle-button");
const scenarioSelect = document.querySelector("#scenario-select");

function selectedScenario() { return scenarios[scenarioSelect.value]; }

function updateScenario() {
  document.querySelector("#scenario-description").textContent = selectedScenario().description;
  resetSimulation();
}

function activeLinks(path) {
  const pairs = new Set(path.slice(1).map((node, index) => [path[index], node].sort().join("-")));
  document.querySelectorAll("[data-link]").forEach((link) => {
    const normalized = link.dataset.link.split("-").sort().join("-");
    link.classList.toggle("active", pairs.has(normalized));
  });
}

function appendLog(from, to, protocol, response) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const title = document.createElement("strong");
  title.textContent = `${nodeLabels[from]} → ${nodeLabels[to]}`;
  const detail = document.createElement("small");
  detail.textContent = `${protocol} · ${response ? "ответ" : "запрос"}`;
  entry.append(title, detail);
  const log = document.querySelector("#event-log");
  log.prepend(entry);
  while (log.children.length > 8) log.lastElementChild.remove();
}

function spawnPacket(now) {
  const scenario = selectedScenario();
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("r", "7");
  circle.classList.add("packet", "request");
  packetLayer.append(circle);
  state.packets.push({ circle, path:scenario.path, protocol:scenario.protocol, segment:0, progress:0, lastTime:now });
  state.count += 1;
  document.querySelector("#packet-count").textContent = `${state.count} пакетов`;
}

function updatePacket(packet, now) {
  const elapsed = Math.min(100, now - packet.lastTime);
  packet.lastTime = now;
  packet.progress += elapsed * 0.00055 * state.speed;
  while (packet.progress >= 1 && packet.segment < packet.path.length - 1) {
    packet.progress -= 1;
    const from = packet.path[packet.segment];
    packet.segment += 1;
    const to = packet.path[packet.segment];
    const response = packet.segment >= Math.ceil((packet.path.length - 1) / 2);
    appendLog(from, to, packet.protocol, response);
    packet.circle.classList.toggle("request", !response);
    packet.circle.classList.toggle("response", response);
    document.querySelector("#current-step").textContent = `${nodeLabels[from]} → ${nodeLabels[to]} · ${packet.protocol}`;
    document.querySelectorAll(".node").forEach((node) => node.classList.toggle("active", node.dataset.node === to));
  }
  if (packet.segment >= packet.path.length - 1) return false;
  const start = positions[packet.path[packet.segment]];
  const end = positions[packet.path[packet.segment + 1]];
  const eased = packet.progress * packet.progress * (3 - 2 * packet.progress);
  packet.circle.setAttribute("cx", String(start[0] + (end[0] - start[0]) * eased));
  packet.circle.setAttribute("cy", String(start[1] + (end[1] - start[1]) * eased));
  return true;
}

function frame(now) {
  if (!state.running) return;
  if (!state.lastSpawn || now - state.lastSpawn > 1900 / state.speed) {
    spawnPacket(now);
    state.lastSpawn = now;
  }
  state.packets = state.packets.filter((packet) => {
    const alive = updatePacket(packet, now);
    if (!alive) packet.circle.remove();
    return alive;
  });
  state.animationId = requestAnimationFrame(frame);
}

function setRunning(running) {
  state.running = running;
  toggleButton.textContent = running ? "Ⅱ Пауза" : "▶ Запустить";
  if (running) {
    const now = performance.now();
    state.packets.forEach((packet) => { packet.lastTime = now; });
    state.lastSpawn = 0;
    activeLinks(selectedScenario().path);
    state.animationId = requestAnimationFrame(frame);
  } else {
    cancelAnimationFrame(state.animationId);
    document.querySelector("#current-step").textContent = state.packets.length ? "Симуляция приостановлена" : "Симуляция остановлена";
  }
}

function resetSimulation() {
  setRunning(false);
  state.packets.forEach((packet) => packet.circle.remove());
  state.packets = [];
  state.count = 0;
  state.lastSpawn = 0;
  document.querySelector("#packet-count").textContent = "0 пакетов";
  document.querySelector("#event-log").innerHTML = "";
  document.querySelector("#current-step").textContent = "Симуляция остановлена";
  document.querySelectorAll(".node").forEach((node) => node.classList.remove("active"));
  activeLinks(selectedScenario().path);
}

async function loadVmStates() {
  try {
    const infrastructure = await fetch("/api/infrastructure").then((response) => response.json());
    const statusByVmid = new Map(infrastructure.vms.map((vm) => [String(vm.vmid), vm.status]));
    document.querySelectorAll("[data-vmid]").forEach((node) => node.classList.toggle("offline", statusByVmid.get(node.dataset.vmid) !== "running"));
  } catch { /* The simulation remains usable without live inventory. */ }
}

toggleButton.addEventListener("click", () => setRunning(!state.running));
document.querySelector("#reset-button").addEventListener("click", resetSimulation);
scenarioSelect.addEventListener("change", updateScenario);
document.querySelector("#speed-input").addEventListener("input", (event) => {
  state.speed = Number(event.target.value);
  document.querySelector("#speed-value").textContent = `${state.speed}×`;
});
document.addEventListener("visibilitychange", () => { if (document.hidden && state.running) setRunning(false); });

activeLinks(selectedScenario().path);
loadVmStates();
