import { Terminal } from "/vendor/xterm/xterm.mjs";
import { FitAddon } from "/vendor/xterm/addon-fit.mjs";
import RFB from "/vendor/novnc/core/rfb.js";

const devices = [
  { vmid:100, name:"ISP", channel:"serial0", area:"isp" },
  { vmid:101, name:"HQ-RTR", channel:"serial0", area:"hq-rtr" },
  { vmid:104, name:"HQ-SRV", channel:"serial0", area:"hq-srv" },
  { vmid:106, name:"HQ-CLI", channel:"VNC", area:"hq-cli", vnc:true },
  { vmid:102, name:"BR-RTR", channel:"serial0", area:"br-rtr" },
  { vmid:103, name:"BR-FW", channel:"VNC", area:"br-fw", vnc:true },
  { vmid:105, name:"BR-SRV", channel:"serial0", area:"br-srv" }
];
const state = { stream:null, autoStarted:false, activeVmid:null, lastInterrupts:new Map(), connected:new Set(), terminals:new Map(), rfbs:new Map(), dimensions:new Map(), rawQueues:new Map() };
const grid = document.querySelector("#console-grid");
document.querySelector("#dashboard-link").href = `http://${location.hostname}:8007/`;

function card(vmid) { return document.querySelector(`[data-vmid="${vmid}"]`); }
function isCtrlC(event) { return event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && (event.code === "KeyC" || String(event.key).toLowerCase() === "c" || event.key === "\u0003"); }

function fitWithCursorGutter(vmid, terminal, fit) {
  const dimensions = fit.proposeDimensions();
  if (!dimensions?.cols || !dimensions?.rows) return;
  terminal.resize(dimensions.cols, Math.max(2, dimensions.rows - 1));
  state.dimensions.set(vmid, { cols:terminal.cols, rows:terminal.rows });
  terminal.scrollToBottom();
}

function createTerminal(device, host) {
  const terminal = new Terminal({
    convertEol:true, cursorBlink:true, cursorStyle:"block", disableStdin:true,
    fontFamily:'"Cascadia Mono", Consolas, "Liberation Mono", monospace', fontSize:12, lineHeight:1.18, scrollback:3000,
    theme:{ background:"#050b12", foreground:"#c9d9d2", cursor:"#43dae4", cursorAccent:"#071117", selectionBackground:"#245a66", black:"#071018", red:"#ff6678", green:"#38d89f", yellow:"#f0b94d", blue:"#50a8e8", magenta:"#c787e8", cyan:"#43dae4", white:"#dbe7ef", brightBlack:"#64758a", brightRed:"#ff8795", brightGreen:"#62e7b7", brightYellow:"#f6cc75", brightBlue:"#79bef0", brightMagenta:"#dca5ef", brightCyan:"#73e7ed", brightWhite:"#ffffff" }
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  fitWithCursorGutter(device.vmid, terminal, fit);
  terminal.writeln("Подготавливается root-консоль…");
  terminal.onData((data) => queueRawInput(device.vmid, data));
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || !isCtrlC(event)) return true;
    if (state.connected.has(device.vmid)) sendInterrupt(device.vmid);
    return false;
  });
  host.addEventListener("pointerdown", () => { state.activeVmid = device.vmid; });
  host.addEventListener("focusin", () => { state.activeVmid = device.vmid; });
  let resizeFrame = null;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      try { fitWithCursorGutter(device.vmid, terminal, fit); } catch {}
    });
  }).observe(host);
  state.terminals.set(device.vmid, { terminal, fit });
}

function vncUrl(vmid, ticket) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/console/${vmid}/vnc?ticket=${encodeURIComponent(ticket)}`;
}

function connectVnc(device) {
  if (state.rfbs.has(device.vmid)) return;
  const host = card(device.vmid).querySelector(".vnc-screen");
  const ticket = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const rfb = new RFB(host, vncUrl(device.vmid, ticket), { credentials:{ password:ticket } });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.showDotCursor = true;
  rfb.background = "#050b12";
  state.rfbs.set(device.vmid, rfb);
  setStatus(device.vmid, "connecting", "VNC подключается…");
  rfb.addEventListener("credentialsrequired", () => rfb.sendCredentials({ password:ticket }));
  rfb.addEventListener("connect", () => {
    host.classList.add("ready");
    setStatus(device.vmid, "connected", "Графическая VNC-консоль");
    host.focus();
  });
  rfb.addEventListener("securityfailure", (event) => setStatus(device.vmid, "error", event.detail?.reason || "Ошибка VNC-аутентификации"));
  rfb.addEventListener("disconnect", (event) => {
    state.rfbs.delete(device.vmid);
    host.classList.remove("ready");
    setStatus(device.vmid, event.detail?.clean ? "disconnected" : "error", event.detail?.clean ? "Отключено" : "VNC-соединение потеряно");
  });
}

function disconnectVnc(device) {
  const rfb = state.rfbs.get(device.vmid);
  if (rfb) rfb.disconnect();
  state.rfbs.delete(device.vmid);
  card(device.vmid)?.querySelector(".vnc-screen")?.classList.remove("ready");
  setStatus(device.vmid, "disconnected");
}

function renderCards() {
  grid.insertAdjacentHTML("beforeend", '<div class="branch-heading hq-heading"><span>ЛЕВАЯ ЛИНИЯ</span><strong>HQ</strong></div><div class="branch-heading br-heading"><span>ПРАВАЯ ЛИНИЯ</span><strong>BR</strong></div>');
  for (const device of devices) {
    const article = document.createElement("article");
    article.className = `console-card${device.vnc ? " vnc-card" : ""}`;
    article.dataset.vmid = device.vmid;
    article.style.gridArea = device.area;
    article.innerHTML = `<header class="console-card-header"><div class="console-title"><i></i><span><strong>${device.vmid} · ${device.name}</strong><small>Отключено</small></span></div><div class="card-actions"><span class="channel">${device.channel}</span>${device.vnc ? "" : '<button class="card-interrupt" type="button" disabled>Ctrl+C</button>'}<button class="card-connect" type="button">Подключить</button></div></header>${device.vnc ? `<div class="vnc-screen" tabindex="0" aria-label="Графическая консоль ${device.name}"><span class="vnc-placeholder">Подготавливается графическая консоль…</span></div>` : `<div class="terminal" aria-label="Консоль ${device.name}"></div>`}`;
    article.querySelector(".card-connect").addEventListener("click", () => state.connected.has(device.vmid) ? disconnect(device.vmid) : connect(device.vmid));
    article.querySelector(".card-interrupt")?.addEventListener("click", () => sendInterrupt(device.vmid));
    grid.append(article);
    if (!device.vnc) createTerminal(device, article.querySelector(".terminal"));
  }
}

async function api(path, body = {}) {
  const response = await fetch(path, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function terminalFor(vmid) { return state.terminals.get(vmid)?.terminal; }
function writeAndFollow(terminal, data) {
  if (!terminal) return;
  terminal.write(data, () => terminal.scrollToBottom());
}
function appendOutput(vmid, data) { writeAndFollow(terminalFor(vmid), data); }

async function flushRawInput(vmid) {
  const queue = state.rawQueues.get(vmid);
  if (!queue || queue.sending) return;
  clearTimeout(queue.timer);
  queue.timer = null;
  queue.sending = true;
  try {
    while (queue.data) {
      const payload = queue.data;
      queue.data = "";
      await api(`/api/console/${vmid}/input`, { raw:true, data:payload });
    }
  } catch (error) {
    appendOutput(vmid, `\r\n\x1b[31mОшибка ввода: ${error.message}\x1b[0m\r\n`);
  } finally {
    queue.sending = false;
    if (queue.data) queue.timer = setTimeout(() => flushRawInput(vmid), 0);
  }
}

function queueRawInput(vmid, data) {
  if (!state.connected.has(vmid)) return;
  if (data.includes("\r") || data.includes("\n")) terminalFor(vmid)?.scrollToBottom();
  const queue = state.rawQueues.get(vmid) || { data:"", timer:null, sending:false };
  queue.data += data;
  clearTimeout(queue.timer);
  queue.timer = setTimeout(() => flushRawInput(vmid), data.includes("\r") || data.includes("\n") ? 0 : 20);
  state.rawQueues.set(vmid, queue);
}

function sendInterrupt(vmid) {
  const now = performance.now();
  if (now - (state.lastInterrupts.get(vmid) || 0) < 100) return;
  state.lastInterrupts.set(vmid, now);
  api(`/api/console/${vmid}/interrupt`).catch((error) => appendOutput(vmid, `\r\n\x1b[31mCtrl+C: ${error.message}\x1b[0m\r\n`));
}

function setStatus(vmid, status, detail) {
  const element = card(vmid);
  if (!element) return;
  element.classList.toggle("connected", status === "connected");
  element.classList.toggle("error", status === "error");
  const connected = status === "connected";
  if (connected) state.connected.add(vmid); else state.connected.delete(vmid);
  element.querySelector(".console-title small").textContent = detail || ({ connected:"Подключено", disconnected:"Отключено", connecting:"Подключение…", error:"Ошибка" })[status] || status;
  element.querySelector(".card-connect").textContent = connected ? "Отключить" : "Подключить";
  const interruptButton = element.querySelector(".card-interrupt");
  if (interruptButton) interruptButton.disabled = !connected;
  const terminal = terminalFor(vmid);
  if (terminal) {
    terminal.options.disableStdin = !connected;
    if (connected) {
      const size = state.dimensions.get(vmid);
      if (size) api(`/api/console/${vmid}/resize`, size).catch(() => {});
      terminal.focus();
    }
  }
}

document.addEventListener("keydown", (event) => {
  if (!isCtrlC(event) || state.activeVmid === null || !state.connected.has(state.activeVmid)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const device = devices.find((item) => item.vmid === state.activeVmid);
  if (!device?.vnc) sendInterrupt(state.activeVmid);
}, true);

function openEventStream() {
  state.stream?.close();
  const stream = new EventSource("/api/console/events");
  state.stream = stream;
  stream.onopen = () => {
    document.querySelector("#secure-user").textContent = "root-консоли · HTTPS";
    if (state.autoStarted) return;
    state.autoStarted = true;
    Promise.all(devices.map((device) => connect(device.vmid))).catch(() => {});
  };
  stream.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "output") appendOutput(event.vmid, event.data);
    if (event.type === "status") setStatus(event.vmid, event.status, event.message || event.channel);
  };
  stream.onerror = () => { if (state.stream === stream) document.querySelector("#secure-user").textContent = "Поток консолей потерян"; };
}

async function connect(vmid) {
  const device = devices.find((item) => item.vmid === vmid);
  if (device?.vnc) return connectVnc(device);
  setStatus(vmid, "connecting");
  try { terminalFor(vmid)?.clear(); await api(`/api/console/${vmid}/connect`); }
  catch (error) { setStatus(vmid, "error", error.message); appendOutput(vmid, `\x1b[31mОшибка: ${error.message}\x1b[0m\r\n`); }
}

async function disconnect(vmid) {
  const device = devices.find((item) => item.vmid === vmid);
  if (device?.vnc) return disconnectVnc(device);
  try { await api(`/api/console/${vmid}/disconnect`); }
  finally { setStatus(vmid, "disconnected"); }
}

function unlock() {
  document.querySelector("#secure-user").textContent = "Подключение root-консолей…";
  openEventStream();
}

document.querySelector("#connect-all").addEventListener("click", async () => { await Promise.all(devices.filter((device) => !state.connected.has(device.vmid)).map((device) => connect(device.vmid))); });
document.querySelector("#disconnect-all").addEventListener("click", async () => { await Promise.all(devices.filter((device) => state.connected.has(device.vmid)).map((device) => disconnect(device.vmid))); });

renderCards();
fetch("/api/console/session").then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))).then(unlock).catch((error) => {
  document.querySelector("#secure-user").textContent = `Ошибка: ${error.message}`;
});
