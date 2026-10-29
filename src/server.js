import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot } from "./data/assessment.js";
import { applyLiveInfrastructure, getInfrastructure, resetInfrastructureCache } from "./services/infrastructure.js";
import { trafficCapture } from "./services/traffic-capture.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 8007);
const runs = new Map();
const assessmentCheckTotal = 27;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": types[".json"], "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, { ok: true, mode: process.env.CHECKER_MODE || "mock", time: new Date().toISOString() });
  }

  if (request.method === "GET" && url.pathname === "/api/assessment") {
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

  if (request.method === "GET" && await serveStatic(url.pathname, response)) return;
  json(response, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Web Demo Checker: http://localhost:${port}`);
  console.log(`Transport: ${process.env.CHECKER_TRANSPORT || "ssh"}`);
});
