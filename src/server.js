import http from "node:http";
import https from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot } from "./data/assessment.js";
import { applyLiveInfrastructure, getInfrastructure, resetInfrastructureCache } from "./services/infrastructure.js";
import { trafficCapture } from "./services/traffic-capture.js";
import { consoleCenter } from "./services/console-center.js";
import { createSession, sessionCookie, sessionFromRequest } from "./services/console-auth.js";
import { attachVncWebSocket } from "./services/vnc-websocket.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const novncRoot = fileURLToPath(new URL("../node_modules/@novnc/novnc/", import.meta.url));
const vendorFiles = new Map([
  ["/vendor/xterm/xterm.mjs", fileURLToPath(new URL("../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url))],
  ["/vendor/xterm/xterm.css", fileURLToPath(new URL("../node_modules/@xterm/xterm/css/xterm.css", import.meta.url))],
  ["/vendor/xterm/addon-fit.mjs", fileURLToPath(new URL("../node_modules/@xterm/addon-fit/lib/addon-fit.mjs", import.meta.url))]
]);
const port = Number(process.env.PORT || 8007);
const consolePort = Number(process.env.CONSOLE_HTTPS_PORT || 8443);
const runs = new Map();
const assessmentCheckTotal = 30;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": types[".json"], "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request, limit = 8_192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function publishRunEvent(run, payload) {
  const event = { sequence: run.events.length + 1, at: new Date().toISOString(), ...payload };
  run.events.push(event);
  for (const client of run.clients) sendEvent(client, event);
  return event;
}

function beginRun() {
  const run = {
    id: `run-${Date.now()}`,
    status: "running",
    startedAt: new Date().toISOString(),
    completed: 0,
    total: assessmentCheckTotal,
    events: [],
    clients: new Set(),
    assessment: null
  };
  runs.set(run.id, run);

  queueMicrotask(async () => {
    try {
      const disconnected = await consoleCenter.resetConnections();
      publishRunEvent(run, {
        type: "command",
        completed: run.completed,
        total: run.total,
        command: "release serial consoles",
        message: disconnected
          ? `Перед проверкой отключено консольных подключений: ${disconnected}`
          : "Serial-консоли свободны, активных подключений нет"
      });
      const assessment = await applyLiveInfrastructure(snapshot(), {
        report(entry) {
          if (entry.kind === "result") run.completed = Math.min(run.total, run.completed + 1);
          publishRunEvent(run, { type: entry.kind, completed: run.completed, total: run.total, ...entry });
        }
      });
      assessment.lab.checkedAt = new Date().toISOString();
      run.assessment = assessment;
      run.completed = run.total;
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      publishRunEvent(run, { type: "complete", completed: run.total, total: run.total, assessment });
    } catch (error) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.error = error.message;
      publishRunEvent(run, { type: "error", completed: run.completed, total: run.total, message: error.message });
    } finally {
      for (const client of run.clients) client.end();
      run.clients.clear();
    }
  });

  while (runs.size > 20) runs.delete(runs.keys().next().value);
  return run;
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = normalize(join(root, requested));
  if (!resolved.startsWith(root)) return false;

  try {
    const content = await readFile(resolved);
    response.writeHead(200, {
      "Content-Type": types[extname(resolved)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

async function serveVendor(pathname, response) {
  let resolved = vendorFiles.get(pathname);
  if (!resolved && pathname.startsWith("/vendor/novnc/")) {
    const relative = pathname.slice("/vendor/novnc/".length);
    const candidate = normalize(join(novncRoot, relative));
    if (candidate.startsWith(novncRoot)) resolved = candidate;
  }
  if (!resolved) return false;
  try {
    const content = await readFile(resolved);
    response.writeHead(200, { "Content-Type": extname(resolved) === ".css" ? types[".css"] : types[".js"], "Cache-Control": "public, max-age=86400" });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

async function handleRequest(request, response) {
  const secure = Boolean(request.socket.encrypted);
  const url = new URL(request.url, `${secure ? "https" : "http"}://${request.headers.host || "localhost"}`);

  if (!secure && url.pathname === "/consoles.html") {
    const hostname = (request.headers.host || "localhost").split(":")[0];
    response.writeHead(302, { Location: `https://${hostname}:${consolePort}/consoles.html` });
    return response.end();
  }

  if (url.pathname.startsWith("/api/console/")) {
    if (!secure) return json(response, 426, { error: "HTTPS required" });

    if (request.method === "GET" && url.pathname === "/api/console/session") {
      const existing = sessionFromRequest(request);
      if (existing) return json(response, 200, { ok: true, user: "root", expiresAt: existing.expiresAt });
      const token = createSession(request);
      return json(response, 200, { ok: true, user: "root" }, { "Set-Cookie": sessionCookie(token) });
    }

    const session = sessionFromRequest(request);
    if (!session) return json(response, 401, { error: "Требуется вход" });

    if (request.method === "GET" && url.pathname === "/api/console/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      response.write(": connected\n\n");
      consoleCenter.addClient(session.token, response);
      request.on("close", () => consoleCenter.removeClient(session.token, response));
      return;
    }

    const match = url.pathname.match(/^\/api\/console\/(\d+)\/(connect|input|interrupt|resize|disconnect)$/);
    if (request.method === "POST" && match) {
      const vmid = Number(match[1]);
      try {
        if (match[2] === "connect") await consoleCenter.connect(session.token, vmid);
        if (match[2] === "input") {
          const { command, data, raw } = await readJson(request);
          await consoleCenter.input(session.token, vmid, raw ? data : command, { raw: Boolean(raw) });
        }
        if (match[2] === "interrupt") await consoleCenter.interrupt(session.token, vmid);
        if (match[2] === "resize") {
          const { cols, rows } = await readJson(request);
          consoleCenter.resize(session.token, vmid, cols, rows);
        }
        if (match[2] === "disconnect") await consoleCenter.disconnect(session.token, vmid);
        return json(response, 200, { ok: true });
      } catch (error) {
        return json(response, 400, { error: error.message });
      }
    }
    return json(response, 404, { error: "Console endpoint not found" });
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, { ok: true, mode: process.env.CHECKER_MODE || "mock", time: new Date().toISOString() });
  }

  if (request.method === "GET" && url.pathname === "/api/assessment") {
    await consoleCenter.resetConnections();
    return json(response, 200, await applyLiveInfrastructure(snapshot()));
  }

  if (request.method === "GET" && url.pathname === "/api/infrastructure") {
    try {
      const fresh = url.searchParams.get("fresh") === "1";
      return json(response, 200, await getInfrastructure({ fresh }));
    } catch (error) {
      return json(response, 502, { error: "Proxmox inventory unavailable", message: error.message });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/traffic/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.write(": connected\n\n");
    await trafficCapture.addClient(response);
    request.on("close", () => trafficCapture.removeClient(response));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    resetInfrastructureCache();
    const run = beginRun();
    return json(response, 202, { id: run.id, status: run.status, startedAt: run.startedAt, completed: 0, total: run.total });
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(\/events)?$/);
  if (request.method === "GET" && runMatch) {
    const run = runs.get(runMatch[1]);
    if (!run) return json(response, 404, { error: "Run not found" });
    if (runMatch[2] === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      response.write(": connected\n\n");
      run.events.forEach((event) => sendEvent(response, event));
      if (run.status === "running") {
        run.clients.add(response);
        request.on("close", () => run.clients.delete(response));
      } else {
        response.end();
      }
      return;
    }
    return json(response, 200, {
      id: run.id, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt,
      completed: run.completed, total: run.total, error: run.error, assessment: run.assessment
    });
  }

  if (request.method === "GET" && await serveVendor(url.pathname, response)) return;
  if (request.method === "GET" && await serveStatic(url.pathname, response)) return;
  json(response, 404, { error: "Not found" });
}

const server = http.createServer(handleRequest);

server.listen(port, "0.0.0.0", () => {
  console.log(`Web Demo Checker: http://localhost:${port}`);
  console.log(`Transport: ${process.env.CHECKER_TRANSPORT || "ssh"}`);
});

const tlsKey = process.env.CONSOLE_TLS_KEY || "/etc/web-demo-checker/tls.key";
const tlsCert = process.env.CONSOLE_TLS_CERT || "/etc/web-demo-checker/tls.crt";
if (existsSync(tlsKey) && existsSync(tlsCert)) {
  const consoleServer = https.createServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }, handleRequest);
  attachVncWebSocket(consoleServer, sessionFromRequest);
  consoleServer.listen(consolePort, "0.0.0.0", () => {
    console.log(`Console Center: https://localhost:${consolePort}`);
  });
} else {
  console.warn(`Console Center disabled: TLS certificate not found at ${tlsCert}`);
}
