const state = { assessment: null, selected: "hq-rtr", running: false };
const $ = (selector) => document.querySelector(selector);

function deviceStatus(device) {
  if (device.state !== "running") return "offline";
  if (device.checks.some((check) => check.status === "fail")) return "fail";
  if (device.checks.some((check) => check.status === "warning")) return "warning";
  if (device.checks.every((check) => check.status === "unknown")) return "unknown";
  return "pass";
}

function statusMeta(status) {
  return {
    pass: { symbol: "✓", label: "Выполнено" },
    warning: { symbol: "!", label: "Частично выполнено" },
    fail: { symbol: "×", label: "Не выполнено" },
    unknown: { symbol: "—", label: "Не проверено" }
  }[status];
}

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }).format(date);
}

function renderSummary() {
  const { lab, devices } = state.assessment;
  const checks = devices.flatMap((device) => device.checks);
  const liveChecks = checks.filter((check) => check.source === "live");
  const score = liveChecks.reduce((sum, check) => sum + check.score, 0);
  const max = liveChecks.reduce((sum, check) => sum + check.maxScore, 0);
  const percent = max ? Math.round(score / max * 100) : 0;

  $("#lab-title").textContent = lab.title;
  $("#lab-subtitle").textContent = lab.subtitle;
  const live = lab.connection?.ok;
  $("#connection-label").textContent = live ? `${lab.connection.node} · SSH` : "Mock fallback";
  $("#connection-dot").classList.toggle("offline", !live);
  $("#data-mode").textContent = live ? "Live-инвентарь · mock отключён" : "Автономный mock-режим";
  $("#data-mode").classList.toggle("mock", !live);
  $("#checked-at").textContent = formatDate(lab.checkedAt);
  $("#score-value").textContent = score;
  $("#score-max").textContent = `/ ${max}`;
  $("#score-percent").textContent = `${percent}%`;
  $("#score-ring").style.setProperty("--score", percent);
  $("#score-caption").textContent = max ? `${liveChecks.length} из ${checks.length} критериев подключено` : "Нет выполненных проверок";
  $("#passed-count").textContent = checks.filter((check) => check.status === "pass").length;
  $("#warning-count").textContent = checks.filter((check) => check.status === "warning").length;
  $("#failed-count").textContent = checks.filter((check) => check.status === "fail").length;
  $("#unknown-count").textContent = checks.filter((check) => check.status === "unknown").length;
  $("#online-count").textContent = `${devices.filter((device) => device.state === "running").length}/${devices.length} online`;
}

function renderDevices() {
  const list = $("#device-list");
  list.innerHTML = "";
  for (const device of state.assessment.devices) {
    const status = deviceStatus(device);
    const row = document.createElement("button");
    row.className = `device-row ${device.state}${device.id === state.selected ? " active" : ""}`;
    row.dataset.id = device.id;
    row.setAttribute("role", "listitem");
    row.innerHTML = `
      <span class="device-icon" style="border-color:${device.color}"></span>
      <span class="device-copy"><strong>${device.vmid} · ${device.name}</strong></span>
      <span class="device-result">${device.score}/${device.assessedMaxScore ?? device.maxScore}<i class="${status}"></i></span>`;
    row.addEventListener("click", () => selectDevice(device.id));
    list.append(row);
  }
}

function renderDetail() {
  const device = state.assessment.devices.find((item) => item.id === state.selected);
  if (!device) return;
  $("#detail-empty").hidden = true;
  $("#detail-content").hidden = false;
  $("#device-name").textContent = `${device.vmid} · ${device.name}`;
  $("#device-role").textContent = device.role;
  $("#device-state").textContent = device.state.toUpperCase();
  $("#device-state").classList.toggle("stopped", device.state !== "running");
  $("#device-score").textContent = device.score;
  $("#device-max").textContent = ` / ${device.assessedMaxScore ?? device.maxScore}`;
  $("#device-glyph").style.color = device.color;
  $("#check-total").textContent = `${device.checks.length} критериев`;

  const list = $("#check-list");
  list.innerHTML = "";
  for (const check of device.checks) {
    const meta = statusMeta(check.status);
    const item = document.createElement("article");
    item.className = "check-item";
    item.innerHTML = `
      <button class="check-summary" aria-expanded="false">
        <span class="status-symbol ${check.status}">${meta.symbol}</span>
        <span class="check-title"><strong>${check.title}${check.source === "live" ? '<em class="live-badge">LIVE</em>' : ""}</strong><small>${meta.label} · ${check.method}</small></span>
        <span class="check-score">${check.score}<small> / ${check.maxScore}</small></span>
        <span class="expand-icon">⌄</span>
      </button>
      <div class="evidence"><div><span class="evidence-label">Evidence</span><p>${check.evidence}</p></div><span class="duration">${check.duration == null ? "—" : `${check.duration} ms`}</span></div>`;
    item.querySelector("button").addEventListener("click", (event) => {
      item.classList.toggle("open");
      event.currentTarget.setAttribute("aria-expanded", item.classList.contains("open"));
    });
    list.append(item);
  }
}

function selectDevice(id) {
  state.selected = id;
  renderDevices();
  renderDetail();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2800);
}

function setRunProgress(completed, total, message) {
  const safeTotal = total || 1;
  const percent = Math.min(100, Math.round(completed / safeTotal * 100));
  $("#run-progress-value").textContent = `${completed} / ${total}`;
  $("#run-progress-bar").style.width = `${percent}%`;
  $(".progress-track").setAttribute("aria-valuemax", total);
  $(".progress-track").setAttribute("aria-valuenow", completed);
  if (message) $("#run-status").textContent = message;
}

function appendLog(event) {
  if (event.type !== "command" && event.type !== "result" && event.type !== "error") return;
  const row = document.createElement("div");
  row.className = "log-line";
  const time = new Date(event.at).toLocaleTimeString("ru-RU", { hour12: false });
  const device = event.vmid ? `VM ${event.vmid}` : "NODE";
  const content = event.type === "command" ? `$ ${event.command}` : event.message;
  const resultClass = event.type === "result" ? `log-result ${event.check?.status || "unknown"}` : event.type === "error" ? "log-result fail" : "log-command";
  for (const [className, value] of [["log-time", time], ["log-device", device], [resultClass, content]]) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = value;
    row.append(span);
  }
  const log = $("#command-log");
  log.append(row);
  log.scrollTop = log.scrollHeight;
}

function waitForRun(run) {
  return new Promise((resolve, reject) => {
    const stream = new EventSource(`/api/runs/${run.id}/events`);
    let finished = false;
    stream.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      appendLog(event);
      setRunProgress(event.completed, event.total, event.message);
      if (event.type === "complete") {
        finished = true;
        stream.close();
        resolve(event.assessment);
      } else if (event.type === "error") {
        finished = true;
        stream.close();
        reject(new Error(event.message));
      }
    };
    stream.onerror = () => {
      stream.close();
      if (!finished) reject(new Error("Поток проверки был прерван"));
    };
  });
}

async function runAssessment() {
  if (state.running) return;
  state.running = true;
  const button = $("#run-button");
  button.disabled = true;
  button.innerHTML = "Проверка выполняется…";
  document.querySelector(".workspace").classList.add("running-shimmer");
  const monitor = $("#run-monitor");
  monitor.hidden = false;
  monitor.className = "run-monitor";
  $("#command-log").innerHTML = "";
  setRunProgress(0, 27, "Подготовка проверки…");
  monitor.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const started = await fetch("/api/runs", { method: "POST" }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    setRunProgress(0, started.total, "Проверяем инфраструктуру…");
    state.assessment = await waitForRun(started);
    renderSummary();
    renderDevices();
    renderDetail();
    monitor.classList.add("completed");
    setRunProgress(started.total, started.total, "Проверка завершена");
    showToast("Проверка завершена · результаты обновлены");
  } catch (error) {
    monitor.classList.add("failed");
    $("#run-status").textContent = "Проверка прервана";
    showToast(`Не удалось запустить проверку: ${error.message}`);
  } finally {
    state.running = false;
    button.disabled = false;
    button.innerHTML = '<span class="play">▶</span> Запустить проверку';
    document.querySelector(".workspace").classList.remove("running-shimmer");
  }
}

async function init() {
  try {
    state.assessment = await fetch("/api/assessment").then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    renderSummary();
    renderDevices();
    renderDetail();
  } catch (error) {
    $("#lab-title").textContent = "Сервис недоступен";
    $("#lab-subtitle").textContent = error.message;
  }
}

$("#run-button").addEventListener("click", runAssessment);
$("#clear-log").addEventListener("click", () => { $("#command-log").innerHTML = ""; });
init();
