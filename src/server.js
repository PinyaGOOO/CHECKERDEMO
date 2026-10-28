import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot } from "./data/assessment.js";
import { applyLiveInfrastructure, getInfrastructure, resetInfrastructureCache } from "./services/infrastructure.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 8007);

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

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = normalize(join(root, requested));
  if (!resolved.startsWith(root)) return false;

  try {
    const content = await readFile(resolved);
    response.writeHead(200, {
      "Content-Type": types[extname(resolved)] || "application/octet-stream",
      "Cache-Control": extname(resolved) === ".html" ? "no-cache" : "public, max-age=300"
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

  if (request.method === "POST" && url.pathname === "/api/runs") {
    resetInfrastructureCache();
    const runId = `run-${Date.now()}`;
    return json(response, 202, { id: runId, status: "running", startedAt: new Date().toISOString() });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
    return json(response, 200, {
      id: url.pathname.split("/").at(-1),
      status: "completed",
      assessment: await applyLiveInfrastructure(snapshot())
    });
  }

  if (request.method === "GET" && await serveStatic(url.pathname, response)) return;
  json(response, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Web Demo Checker: http://localhost:${port}`);
  console.log(`Transport: ${process.env.CHECKER_TRANSPORT || "ssh"}`);
});
