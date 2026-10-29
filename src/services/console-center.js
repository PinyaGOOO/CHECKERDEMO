import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { ProxmoxSshAdapter } from "../adapters/proxmox-ssh.js";
import { cleanTerminalOutput } from "../adapters/ecorouter-serial.js";

const allowedVmids = new Set([100, 101, 102, 103, 104, 105, 106]);
const qgaVmids = new Set([103]);
const linuxSerialVmids = new Set([100, 104, 105, 106]);
const adapter = new ProxmoxSshAdapter({ transport: "local", timeout: 12_000 });
const rootConsoleUnit = "web-demo-checker-console.service";

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
    if (!this.owners.has(token)) this.owners.set(token, { clients: new Set(), devices: new Map(), sizes: new Map(), closeTimer: null });
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
      this.publish(token, { type: "output", vmid, data: "Root QGA shell готов. Команды выполняются по Enter.\r\n# " });
      return;
    }

    let credentials = null;
    try {
      if (linuxSerialVmids.has(vmid)) await this.startRootConsole(vmid);
      else credentials = await adapter.vmConsoleCredentials(vmid);
    } catch (error) {
      this.locks.delete(vmid);
      throw error;
    }
    const socket = net.createConnection({ path: `/var/run/qemu-server/${vmid}.serial0` });
    const device = {
      type: "serial",
      socket,
      decoder: new StringDecoder("utf8"),
      buffer: "",
      sentUser: false,
      sentPassword: false,
      resetting: true,
      sttyApplied: false,
      rootConsole: linuxSerialVmids.has(vmid)
    };
    owner.devices.set(vmid, device);
    socket.on("connect", () => {
      this.publish(token, { type: "status", vmid, status: "connected", channel: "serial0" });
      socket.write("\x03\r\n");
    });
    socket.on("data", (chunk) => {
      // Serial data can split a UTF-8 character between chunks. StringDecoder
      // retains incomplete bytes so localized full-screen apps (notably nano)
      // do not render replacement characters in their status/help rows.
      const output = device.decoder.write(chunk);
      const plainOutput = cleanTerminalOutput(output);
      device.buffer = `${device.buffer}${plainOutput}`.slice(-600);
      this.publish(token, { type: "output", vmid, data: output });
      if (device.resetting && /--More--/i.test(plainOutput)) {
        device.resetting = false;
        socket.write("q");
        setTimeout(() => socket.write("\x03\r\n"), 120);
      } else if (credentials && !device.sentUser && /login:\s*$/i.test(device.buffer)) {
        device.sentUser = true;
        socket.write(`${credentials.username}\r\n`);
      } else if (credentials && !device.sentPassword && /Password:\s*$/i.test(device.buffer)) {
        device.sentPassword = true;
        socket.write(`${credentials.password}\r\n`);
      }
      if (/[#>]\s*$/.test(device.buffer)) device.resetting = false;
      this.applyTerminalSize(owner, vmid, device);
    });
    socket.on("error", (error) => {
      this.publish(token, { type: "status", vmid, status: "error", message: error.message });
      owner.devices.delete(vmid);
      this.locks.delete(vmid);
      if (device.rootConsole) this.stopRootConsole(vmid).catch(() => {});
    });
    socket.on("close", () => {
      this.publish(token, { type: "status", vmid, status: "disconnected" });
      owner.devices.delete(vmid);
      this.locks.delete(vmid);
    });
  }

  async startRootConsole(vmid) {
    const cleanup = `systemctl kill -s KILL ${rootConsoleUnit} 2>/dev/null || true; systemctl stop --no-block ${rootConsoleUnit} 2>/dev/null || true; for i in 1 2 3 4 5 6 7 8 9 10; do systemctl is-active --quiet ${rootConsoleUnit} || break; sleep 0.1; done; systemctl reset-failed ${rootConsoleUnit} 2>/dev/null || true`;
    const launch = [
      `systemd-run --unit=${rootConsoleUnit.replace(/\.service$/, "")} --collect`,
      "--property=StandardInput=tty --property=StandardOutput=tty --property=StandardError=tty",
      "--property=TTYPath=/dev/ttyS0 --property=TTYReset=yes --property=TTYVHangup=yes",
      "--property=TTYVTDisallocate=no --property=KillMode=mixed --property=TimeoutStopSec=1s",
      "--setenv=TERM=xterm-256color /bin/bash -il"
    ].join(" ");
    const result = await adapter.guestExec(vmid, "/bin/sh", ["-lc", `${cleanup}; systemctl stop serial-getty@ttyS0.service; ${launch}`]);
    if (result.exitcode !== 0) throw new Error(result["err-data"] || `Root console failed with exit ${result.exitcode}`);
  }

  async stopRootConsole(vmid) {
    const command = `systemctl kill -s KILL ${rootConsoleUnit} 2>/dev/null || true; systemctl stop --no-block ${rootConsoleUnit} 2>/dev/null || true; for i in 1 2 3 4 5 6 7 8 9 10; do systemctl is-active --quiet ${rootConsoleUnit} || break; sleep 0.1; done; systemctl reset-failed ${rootConsoleUnit} 2>/dev/null || true; systemctl start serial-getty@ttyS0.service`;
    await adapter.guestExec(vmid, "/bin/sh", ["-lc", command]);
  }

  applyTerminalSize(owner, vmid, device) {
    if (!linuxSerialVmids.has(vmid) || device.sttyApplied || !/[$#]\s*$/.test(device.buffer)) return;
    const size = owner.sizes.get(vmid);
    if (!size) return;
    device.sttyApplied = true;
    device.socket.write(`stty rows ${size.rows} cols ${size.cols} -ixon -ixoff; export TERM=xterm-256color\r\n`);
  }

  resize(token, vmid, cols, rows) {
    if (!allowedVmids.has(vmid)) throw new Error("Unsupported VMID");
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 4 || rows > 200) throw new Error("Invalid terminal size");
    const owner = this.owner(token);
    owner.sizes.set(vmid, { cols, rows });
    const device = owner.devices.get(vmid);
    if (device?.type === "serial") this.applyTerminalSize(owner, vmid, device);
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
      this.publish(token, { type: "output", vmid, data: `${output || `[exit ${result.exitcode ?? 0}]\n`}\r\n# ` });
    } catch (error) {
      this.publish(token, { type: "output", vmid, data: `Ошибка QGA: ${error.message}\r\n# ` });
    }
  }

  interrupt(token, vmid) {
    if (!allowedVmids.has(vmid)) throw new Error("Unsupported VMID");
    const device = this.owner(token).devices.get(vmid);
    if (!device) throw new Error("Console is not connected");
    if (device.type !== "serial") throw new Error("Ctrl+C доступен только в serial-консолях");
    device.socket.write("\u0003");
  }

  async disconnect(token, vmid) {
    const owner = this.owners.get(token);
    const device = owner?.devices.get(vmid);
    if (!device) return;
    owner.devices.delete(vmid);
    this.locks.delete(vmid);
    if (device.type === "serial") device.socket.end();
    if (device.rootConsole) await this.stopRootConsole(vmid).catch(() => {});
    this.publish(token, { type: "status", vmid, status: "disconnected" });
  }

  closeOwner(token) {
    const owner = this.owners.get(token);
    if (!owner) return;
    clearTimeout(owner.closeTimer);
    for (const [vmid, device] of owner.devices) {
      if (device.type === "serial") device.socket.end();
      if (device.rootConsole) this.stopRootConsole(vmid).catch(() => {});
      owner.devices.delete(vmid);
      this.locks.delete(vmid);
    }
    for (const client of owner.clients) client.end();
    this.owners.delete(token);
  }
}

export const consoleCenter = new ConsoleCenter();
