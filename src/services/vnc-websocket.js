import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";

const vncVmids = new Set([103, 106]);
const ticketPattern = /^[A-Za-z0-9_-]{16,128}$/;

function rejectUpgrade(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function bridgeVnc(webSocket, vmid, ticket) {
  const proxy = spawn("/usr/sbin/qm", ["vncproxy", String(vmid)], {
    env: { ...process.env, LC_PVE_TICKET: ticket },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  let closed = false;

  const closeProxy = () => {
    if (closed) return;
    closed = true;
    proxy.stdin.destroy();
    proxy.kill("SIGTERM");
    setTimeout(() => proxy.kill("SIGKILL"), 1_000).unref();
  };

  proxy.stdout.on("data", (chunk) => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(chunk, { binary: true });
  });
  proxy.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1_000); });
  proxy.on("error", (error) => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1011, error.message.slice(0, 120));
  });
  proxy.on("exit", (code) => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.close(code === 0 ? 1000 : 1011, (stderr.trim() || `VNC proxy exited with ${code}`).slice(0, 120));
  });
  webSocket.on("message", (data) => {
    if (!proxy.stdin.destroyed) proxy.stdin.write(data);
  });
  webSocket.on("close", closeProxy);
  webSocket.on("error", closeProxy);
}

export function attachVncWebSocket(server, authenticate) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `https://${request.headers.host || "localhost"}`);
    const match = url.pathname.match(/^\/api\/console\/(\d+)\/vnc$/);
    if (!match) return rejectUpgrade(socket, 404, "Not Found");
    const vmid = Number(match[1]);
    const ticket = url.searchParams.get("ticket") || "";
    const session = authenticate(request);
    const expectedOrigin = `https://${request.headers.host}`;
    if (!session) return rejectUpgrade(socket, 401, "Unauthorized");
    if (request.headers.origin && request.headers.origin !== expectedOrigin) return rejectUpgrade(socket, 403, "Forbidden");
    if (!vncVmids.has(vmid) || !ticketPattern.test(ticket)) return rejectUpgrade(socket, 400, "Bad Request");
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => bridgeVnc(webSocket, vmid, ticket));
  });
  return webSocketServer;
}
