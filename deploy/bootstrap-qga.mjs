#!/usr/bin/env node
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { cleanTerminalOutput } from "../src/adapters/ecorouter-serial.js";
import { parseVmConsoleCredentials } from "../src/adapters/proxmox-ssh.js";

const execFileAsync = promisify(execFile);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const vmids = (process.env.QGA_GUEST_VMIDS || "100 104 105 106")
  .trim().split(/\s+/).filter(Boolean).map(Number);

async function qm(...args) {
  const { stdout = "" } = await execFileAsync("qm", args.map(String), { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

async function qgaAvailable(vmid) {
  try {
    await qm("guest", "cmd", vmid, "ping");
    return true;
  } catch {
    return false;
  }
}

async function rootCredentials(vmid) {
  const credentials = parseVmConsoleCredentials(await qm("config", vmid), "root");
  if (!credentials || credentials.username !== "root") throw new Error(`VM ${vmid}: в description не найдены данные root`);
  return credentials;
}

async function openRootSerial(vmid, credentials) {
  const socket = net.createConnection({ path: `/var/run/qemu-server/${vmid}.serial0` });
  let buffer = "";
  socket.on("data", (chunk) => { buffer = `${buffer}${cleanTerminalOutput(chunk.toString("utf8"))}`.slice(-8_000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`VM ${vmid}: serial0 не отвечает`)), 8_000);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });

  socket.write("\x03\r\n");
  const deadline = Date.now() + 25_000;
  let sentUser = false;
  let sentPassword = false;
  let lastWakeup = 0;
  while (Date.now() < deadline) {
    await delay(100);
    if (/(?:^|\n)[^\n]*#\s*$/.test(buffer.trimEnd())) return { socket, clear: () => { buffer = ""; }, read: () => buffer };
    if (/login:\s*$/i.test(buffer) && !sentUser) {
      buffer = "";
      sentUser = true;
      socket.write(`${credentials.username}\r\n`);
      continue;
    }
    if (/Password:\s*$/i.test(buffer) && !sentPassword) {
      buffer = "";
      sentPassword = true;
      socket.write(`${credentials.password}\r\n`);
      continue;
    }
    if (/Login incorrect/i.test(buffer)) throw new Error(`VM ${vmid}: root-пароль из description не подошёл`);
    if (Date.now() - lastWakeup >= 800) {
      socket.write("\r\n");
      lastWakeup = Date.now();
    }
  }
  socket.destroy();
  throw new Error(`VM ${vmid}: не удалось получить root prompt через serial0`);
}

async function installAgent(vmid) {
  if (await qgaAvailable(vmid)) {
    console.log(`[qga] VM ${vmid}: агент уже отвечает`);
    return;
  }
  const session = await openRootSerial(vmid, await rootCredentials(vmid));
  const token = randomBytes(10).toString("hex");
  const start = `__QGA_START_${token}__`;
  const end = `__QGA_END_${token}__`;
  const script = [
    "set -e",
    "mount_dir=/run/web-demo-checker-qga-media",
    "mkdir -p \"$mount_dir\"",
    "mounted_here=0",
    "if ! mountpoint -q \"$mount_dir\"; then mount -o ro /dev/sr0 \"$mount_dir\"; mounted_here=1; fi",
    "agent_rpm=$(find \"$mount_dir/ALTLinux/RPMS.main\" -maxdepth 1 -name 'qemu-guest-agent-*.rpm' -print -quit)",
    "aux_rpm=$(find \"$mount_dir/ALTLinux/RPMS.main\" -maxdepth 1 -name 'qemu-aux-*.rpm' -print -quit)",
    "test -n \"$agent_rpm\" && test -n \"$aux_rpm\"",
    "if ! rpm -q qemu-guest-agent >/dev/null 2>&1; then",
    "  rpm_dir=\"$mount_dir/ALTLinux/RPMS.main\"",
    "  rpm -Uvh \"$rpm_dir\"/udev-rules-hotplug-cpu-*.rpm \"$rpm_dir\"/libnuma-[0-9]*.x86_64.rpm \"$rpm_dir\"/liburing-[0-9]*.x86_64.rpm \"$aux_rpm\" \"$agent_rpm\"",
    "fi",
    "systemctl enable qemu-guest-agent.service",
    "systemctl restart qemu-guest-agent.service",
    "if test \"$mounted_here\" = 1; then umount \"$mount_dir\"; fi"
  ].join("\n");
  const encoded = Buffer.from(script).toString("base64");
  session.clear();
  session.socket.write(`printf '${start}\\n'; echo '${encoded}' | base64 -d | /bin/bash; rc=$?; printf '\\n${end}:%s\\n' \"$rc\"\r\n`);

  const deadline = Date.now() + 180_000;
  let exitCode = null;
  while (Date.now() < deadline) {
    await delay(200);
    const match = session.read().match(new RegExp(`${end}:(\\d+)`));
    if (match) { exitCode = Number(match[1]); break; }
  }
  session.socket.end();
  if (exitCode === null) throw new Error(`VM ${vmid}: истекло время установки qemu-guest-agent`);
  if (exitCode !== 0) {
    const transcript = session.read();
    const startOffset = transcript.lastIndexOf(start);
    const endOffset = transcript.indexOf(end, Math.max(0, startOffset));
    const details = transcript.slice(startOffset + start.length, endOffset >= 0 ? endOffset : undefined)
      .split("\n").map((line) => line.trim()).filter((line) => line && line.length < 300).slice(-12).join(" | ");
    throw new Error(`VM ${vmid}: установка qemu-guest-agent завершилась с кодом ${exitCode}${details ? ` · ${details}` : ""}`);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await qgaAvailable(vmid)) {
      console.log(`[qga] VM ${vmid}: пакет установлен, служба отвечает`);
      return;
    }
    await delay(500);
  }
  throw new Error(`VM ${vmid}: пакет установлен, но QGA не ответил`);
}

if (!vmids.length || vmids.some((vmid) => !Number.isInteger(vmid) || vmid < 100)) {
  throw new Error("QGA_GUEST_VMIDS содержит некорректный VMID");
}

for (const vmid of vmids) await installAgent(vmid);
