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
      <span class="device-copy"><strong>${device.vmid} · ${device.name}</strong><small>${device.role}</small></span>
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

async function runAssessment() {
  if (state.running) return;
  state.running = true;
  const button = $("#run-button");
  button.disabled = true;
  button.innerHTML = "Проверяем устройства…";
  document.querySelector(".workspace").classList.add("running-shimmer");

  try {
    const started = await fetch("/api/runs", { method: "POST" }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const result = await fetch(`/api/runs/${started.id}`).then((response) => response.json());
    result.assessment.lab.checkedAt = new Date().toISOString();
    state.assessment = result.assessment;
    renderSummary();
    renderDevices();
    renderDetail();
    showToast("Проверка завершена · результаты обновлены");
  } catch (error) {
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
init();
