import net from "node:net";
import { ProxmoxSshAdapter } from "../adapters/proxmox-ssh.js";
import { cleanTerminalOutput } from "../adapters/ecorouter-serial.js";

const allowedVmids = new Set([100, 101, 102, 103, 104, 105, 106]);
const qgaVmids = new Set([103]);
const adapter = new ProxmoxSshAdapter({ transport: "local", timeout: 12_000 });

class ConsoleCenter {
  constructor() {
    this.owners = new Map();
    this.locks = new Map();
    this.keepalive = setInterval(() => {
      for (const owner of this.owners.values()) for (const client of owner.clients) client.write(": keepalive\n\n");
    }, 15_000);
    this.keepalive.unref();
  }

  owner(token) {
    if (!this.owners.has(token)) this.owners.set(token, { clients: new Set(), devices: new Map(), closeTimer: null });
    return this.owners.get(token);
  }

  publish(token, payload) {
    const event = { at: new Date().toISOString(), ...payload };
    for (const client of this.owner(token).clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  addClient(token, response) {
    const owner = this.owner(token);
    clearTimeout(owner.closeTimer);
    owner.clients.add(response);
    response.write(`data: ${JSON.stringify({ type: "ready", at: new Date().toISOString() })}\n\n`);
  }

  removeClient(token, response) {
    const owner = this.owners.get(token);
    if (!owner) return;
    owner.clients.delete(response);
    if (!owner.clients.size) owner.closeTimer = setTimeout(() => this.closeOwner(token), 2_000);
  }

  async connect(token, vmid) {
    if (!allowedVmids.has(vmid)) throw new Error("Unsupported VMID");
    const owner = this.owner(token);
    if (owner.devices.has(vmid)) return;
    if (this.locks.has(vmid) && this.locks.get(vmid) !== token) throw new Error("Консоль уже открыта в другой сессии");
    this.locks.set(vmid, token);
    if (qgaVmids.has(vmid)) {
      owner.devices.set(vmid, { type: "qga" });
      this.publish(token, { type: "status", vmid, status: "connected", channel: "QGA shell" });
      this.publish(token, { type: "output", vmid, data: "QGA command shell готов. Команды выполняются по Enter.\r\n$ " });
      return;
    }

    let credentials;
    try {
      credentials = await adapter.vmConsoleCredentials(vmid);
    } catch (error) {
      this.locks.delete(vmid);
      throw error;
    }
    const socket = net.createConnection({ path: `/var/run/qemu-server/${vmid}.serial0` });
    const device = { type: "serial", socket, buffer: "", sentUser: false, sentPassword: false };
    owner.devices.set(vmid, device);
    socket.on("connect", () => {
      this.publish(token, { type: "status", vmid, status: "connected", channel: "serial0" });
      socket.write("\x03\r\n");
    });
    socket.on("data", (chunk) => {
      const output = chunk.toString("utf8");
      device.buffer = `${device.buffer}${cleanTerminalOutput(output)}`.slice(-600);
      this.publish(token, { type: "output", vmid, data: output });
      if (!device.sentUser && /login:\s*$/i.test(device.buffer)) {
        device.sentUser = true;
        socket.write(`${credentials.username}\r\n`);
      } else if (!device.sentPassword && /Password:\s*$/i.test(device.buffer)) {
        device.sentPassword = true;
        socket.write(`${credentials.password}\r\n`);
      }
    });
    socket.on("error", (error) => {
      this.publish(token, { type: "status", vmid, status: "error", message: error.message });
      owner.devices.delete(vmid);
      this.locks.delete(vmid);
    });
    socket.on("close", () => {
      this.publish(token, { type: "status", vmid, status: "disconnected" });
      owner.devices.delete(vmid);
      this.locks.delete(vmid);
    });
  }

  async input(token, vmid, value, { raw = false } = {}) {
    if (!allowedVmids.has(vmid)) throw new Error("Unsupported VMID");
    if (typeof value !== "string" || !value.length || value.length > 4096 || value.includes("\u0000")) throw new Error("Invalid console input");
    const device = this.owner(token).devices.get(vmid);
    if (!device) throw new Error("Console is not connected");
    if (device.type === "serial") {
      device.socket.write(raw ? value : `${value}\r\n`);
      return;
    }
    if (raw) throw new Error("Raw input is unavailable for QGA shell");
    try {
      const result = await adapter.guestExec(vmid, "/bin/sh", ["-lc", value]);
      const output = `${result["out-data"] || ""}${result["err-data"] || ""}`;
      this.publish(token, { type: "output", vmid, data: `${output || `[exit ${result.exitcode ?? 0}]\n`}\r\n$ ` });
    } catch (error) {
      this.publish(token, { type: "output", vmid, data: `Ошибка QGA: ${error.message}\r\n$ ` });
    }
  }

  disconnect(token, vmid) {
    const owner = this.owners.get(token);
    const device = owner?.devices.get(vmid);
    if (!device) return;
    owner.devices.delete(vmid);
    this.locks.delete(vmid);
    if (device.type === "serial") device.socket.end();
    this.publish(token, { type: "status", vmid, status: "disconnected" });
  }

  closeOwner(token) {
    const owner = this.owners.get(token);
    if (!owner) return;
    clearTimeout(owner.closeTimer);
    for (const [vmid, device] of owner.devices) {
      if (device.type === "serial") device.socket.end();
      owner.devices.delete(vmid);
      this.locks.delete(vmid);
    }
    for (const client of owner.clients) client.end();
    this.owners.delete(token);
  }
}

export const consoleCenter = new ConsoleCenter();
