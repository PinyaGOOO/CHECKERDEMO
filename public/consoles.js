const devices = [
  { vmid:100, name:"ISP", channel:"serial0" }, { vmid:101, name:"HQ-RTR", channel:"serial0" },
  { vmid:102, name:"BR-RTR", channel:"serial0" }, { vmid:103, name:"BR-FW", channel:"QGA shell" },
  { vmid:104, name:"HQ-SRV", channel:"serial0" }, { vmid:105, name:"BR-SRV", channel:"serial0" },
  { vmid:106, name:"HQ-CLI", channel:"serial0" }
];
const state = { stream:null, connected:new Set() };
const grid = document.querySelector("#console-grid");
document.querySelector("#dashboard-link").href = `http://${location.hostname}:8007/`;

function card(vmid) { return document.querySelector(`[data-vmid="${vmid}"]`); }

function renderCards() {
  for (const device of devices) {
    const article = document.createElement("article");
    article.className = "console-card";
    article.dataset.vmid = device.vmid;
    article.innerHTML = `
      <header class="console-card-header">
        <div class="console-title"><i></i><span><strong>${device.vmid} · ${device.name}</strong><small>Отключено</small></span></div>
        <div class="card-actions"><span class="channel">${device.channel}</span><button class="card-connect" type="button">Подключить</button></div>
      </header>
      <pre class="terminal" aria-live="polite">Нажмите «Подключить», чтобы открыть консоль.\n</pre>
      <form class="command-form"><input aria-label="Команда для ${device.name}" autocomplete="off" spellcheck="false" placeholder="Введите команду…" disabled /><button type="submit" disabled>Enter</button></form>`;
    article.querySelector(".card-connect").addEventListener("click", () => state.connected.has(device.vmid) ? disconnect(device.vmid) : connect(device.vmid));
    article.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = event.currentTarget.querySelector("input");
      const command = input.value;
      if (!command.trim()) return;
      input.value = "";
      await api(`/api/console/${device.vmid}/input`, { command });
    });
    grid.append(article);
  }
}

async function api(path, body = {}) {
  const response = await fetch(path, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function appendOutput(vmid, data) {
  const terminal = card(vmid)?.querySelector(".terminal");
  if (!terminal) return;
  terminal.textContent = `${terminal.textContent}${data}`.slice(-40_000);
  terminal.scrollTop = terminal.scrollHeight;
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
  element.querySelectorAll(".command-form input,.command-form button").forEach((control) => { control.disabled = !connected; });
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
  stream.onerror = () => {
    if (state.stream === stream) document.querySelector("#secure-user").textContent = "Поток консолей потерян";
  };
}

async function connect(vmid) {
  setStatus(vmid, "connecting");
  try { await api(`/api/console/${vmid}/connect`); }
  catch (error) { setStatus(vmid, "error", error.message); appendOutput(vmid, `Ошибка: ${error.message}\n`); }
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
  try {
    await api("/api/console/login", { password:input.value });
    input.value = "";
    error.textContent = "";
    unlock();
  } catch (loginError) {
    input.value = "";
    error.textContent = loginError.message;
    input.focus();
  }
});

document.querySelector("#connect-all").addEventListener("click", async () => {
  for (const device of devices) if (!state.connected.has(device.vmid)) await connect(device.vmid);
});
document.querySelector("#disconnect-all").addEventListener("click", async () => {
  await Promise.all(devices.filter((device) => state.connected.has(device.vmid)).map((device) => disconnect(device.vmid)));
});
document.querySelector("#logout-button").addEventListener("click", async () => {
  await api("/api/console/logout");
  state.stream?.close();
  location.reload();
});

renderCards();
fetch("/api/console/session").then((response) => response.ok ? response.json() : Promise.reject()).then(unlock).catch(() => {});
