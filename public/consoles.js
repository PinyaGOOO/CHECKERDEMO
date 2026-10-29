import { Terminal } from "/vendor/xterm/xterm.mjs";
import { FitAddon } from "/vendor/xterm/addon-fit.mjs";

const devices = [
  { vmid:100, name:"ISP", channel:"serial0" }, { vmid:101, name:"HQ-RTR", channel:"serial0" },
  { vmid:102, name:"BR-RTR", channel:"serial0" }, { vmid:103, name:"BR-FW", channel:"QGA shell", qga:true },
  { vmid:104, name:"HQ-SRV", channel:"serial0" }, { vmid:105, name:"BR-SRV", channel:"serial0" },
  { vmid:106, name:"HQ-CLI", channel:"serial0" }
];
const state = { stream:null, connected:new Set(), terminals:new Map(), qgaBuffers:new Map(), rawQueues:new Map() };
const grid = document.querySelector("#console-grid");
document.querySelector("#dashboard-link").href = `http://${location.hostname}:8007/`;

function card(vmid) { return document.querySelector(`[data-vmid="${vmid}"]`); }

function fitWithCursorGutter(terminal, fit) {
  const dimensions = fit.proposeDimensions();
  if (!dimensions?.cols || !dimensions?.rows) return;
  terminal.resize(dimensions.cols, Math.max(2, dimensions.rows - 1));
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
  fitWithCursorGutter(terminal, fit);
  terminal.writeln("Нажмите «Подключить», чтобы открыть консоль.");
  terminal.onData((data) => device.qga ? handleQgaInput(device.vmid, data) : queueRawInput(device.vmid, data));
  let resizeFrame = null;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      try { fitWithCursorGutter(terminal, fit); } catch {}
    });
  }).observe(host);
  state.terminals.set(device.vmid, { terminal, fit });
}

function renderCards() {
  for (const device of devices) {
    const article = document.createElement("article");
    article.className = "console-card";
    article.dataset.vmid = device.vmid;
    article.innerHTML = `<header class="console-card-header"><div class="console-title"><i></i><span><strong>${device.vmid} · ${device.name}</strong><small>Отключено</small></span></div><div class="card-actions"><span class="channel">${device.channel}</span><button class="card-connect" type="button">Подключить</button></div></header><div class="terminal" aria-label="Консоль ${device.name}"></div>`;
    article.querySelector(".card-connect").addEventListener("click", () => state.connected.has(device.vmid) ? disconnect(device.vmid) : connect(device.vmid));
    grid.append(article);
    createTerminal(device, article.querySelector(".terminal"));
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

function queueRawInput(vmid, data) {
  if (!state.connected.has(vmid)) return;
  if (data.includes("\r") || data.includes("\n")) terminalFor(vmid)?.scrollToBottom();
  const queue = state.rawQueues.get(vmid) || { data:"", timer:null };
  queue.data += data;
  clearTimeout(queue.timer);
  queue.timer = setTimeout(async () => {
    const payload = queue.data;
    queue.data = "";
    try { await api(`/api/console/${vmid}/input`, { raw:true, data:payload }); }
    catch (error) { appendOutput(vmid, `\r\n\x1b[31mОшибка ввода: ${error.message}\x1b[0m\r\n`); }
  }, 24);
  state.rawQueues.set(vmid, queue);
}

function handleQgaInput(vmid, data) {
  if (!state.connected.has(vmid)) return;
  const terminal = terminalFor(vmid);
  let buffer = state.qgaBuffers.get(vmid) || "";
  for (const character of data) {
    if (character === "\r") {
      const command = buffer;
      buffer = "";
      writeAndFollow(terminal, "\r\n");
      if (command.trim()) api(`/api/console/${vmid}/input`, { command }).catch((error) => writeAndFollow(terminal, `\x1b[31m${error.message}\x1b[0m\r\n$ `));
      else writeAndFollow(terminal, "$ ");
    } else if (character === "\u007f") {
      if (buffer.length) { buffer = buffer.slice(0, -1); terminal.write("\b \b"); }
    } else if (character === "\u0003") {
      buffer = "";
      writeAndFollow(terminal, "^C\r\n$ ");
    } else if (character >= " " && character !== "\u007f") {
      buffer += character;
      terminal.write(character);
    }
  }
  state.qgaBuffers.set(vmid, buffer);
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
  const terminal = terminalFor(vmid);
  if (terminal) { terminal.options.disableStdin = !connected; if (connected) terminal.focus(); }
}

function openEventStream() {
  state.stream?.close();
  const stream = new EventSource("/api/console/events");
  state.stream = stream;
  stream.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "output") appendOutput(event.vmid, event.data);
    if (event.type === "status") setStatus(event.vmid, event.status, event.message || event.channel);
  };
  stream.onerror = () => { if (state.stream === stream) document.querySelector("#secure-user").textContent = "Поток консолей потерян"; };
}

async function connect(vmid) {
  setStatus(vmid, "connecting");
  try { terminalFor(vmid)?.clear(); await api(`/api/console/${vmid}/connect`); }
  catch (error) { setStatus(vmid, "error", error.message); appendOutput(vmid, `\x1b[31mОшибка: ${error.message}\x1b[0m\r\n`); }
}

async function disconnect(vmid) {
  try { await api(`/api/console/${vmid}/disconnect`); }
  finally { setStatus(vmid, "disconnected"); }
}

function unlock() {
  document.querySelector("#login-layer").classList.add("hidden");
  document.querySelector("#secure-user").textContent = "root · HTTPS";
  document.querySelector("#logout-button").hidden = false;
  openEventStream();
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#root-password");
  const error = document.querySelector("#login-error");
  error.textContent = "Проверяем пароль…";
  try { await api("/api/console/login", { password:input.value }); input.value = ""; error.textContent = ""; unlock(); }
  catch (loginError) { input.value = ""; error.textContent = loginError.message; input.focus(); }
});

document.querySelector("#connect-all").addEventListener("click", async () => { for (const device of devices) if (!state.connected.has(device.vmid)) await connect(device.vmid); });
document.querySelector("#disconnect-all").addEventListener("click", async () => { await Promise.all(devices.filter((device) => state.connected.has(device.vmid)).map((device) => disconnect(device.vmid))); });
document.querySelector("#logout-button").addEventListener("click", async () => { await api("/api/console/logout"); state.stream?.close(); location.reload(); });

renderCards();
fetch("/api/console/session").then((response) => response.ok ? response.json() : Promise.reject()).then(unlock).catch(() => {});
