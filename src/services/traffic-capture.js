import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";

const execFileAsync = promisify(execFile);
const captureTargets = [
  { bridge: "vmbr0", interface: "tap100i0" },
  { bridge: "ISP_HQ", interface: "ISP_HQ" },
  { bridge: "ISP_BR", interface: "ISP_BR" },
  { bridge: "HQ_NET", interface: "HQ_NET" },
  { bridge: "FW_NET", interface: "FW_NET" },
  { bridge: "BR_NET", interface: "BR_NET" }
];
const bridges = captureTargets.map((target) => target.bridge);
const names = new Map([[100, "ISP"], [101, "HQ-RTR"], [102, "BR-RTR"], [103, "BR-FW"], [104, "HQ-SRV"], [105, "BR-SRV"], [106, "HQ-CLI"]]);

function protocolOf(line) {
  if (/\bARP\b/i.test(line)) return "ARP";
  if (/\bICMP6?\b/i.test(line)) return "ICMP";
  if (/\bFlags\s*\[|\bTCP\b/i.test(line)) return "TCP";
  if (/\bUDP\b/i.test(line)) return "UDP";
  if (/ethertype IPv6/i.test(line)) return "IPv6";
  if (/ethertype IPv4/i.test(line)) return "IPv4";
  return "OTHER";
}

function parseEndpoints(line) {
  const ipv4 = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})(?:\.(\d+))?\s*>\s*(\d{1,3}(?:\.\d{1,3}){3})(?:\.(\d+))?:/);
  if (ipv4) return { srcIp: ipv4[1], srcPort: ipv4[2] ? Number(ipv4[2]) : null, dstIp: ipv4[3], dstPort: ipv4[4] ? Number(ipv4[4]) : null };
  const arp = line.match(/who-has\s+(\d{1,3}(?:\.\d{1,3}){3}).*\btell\s+(\d{1,3}(?:\.\d{1,3}){3})/i);
  if (arp) return { srcIp: arp[2], srcPort: null, dstIp: arp[1], dstPort: null };
  return { srcIp: null, srcPort: null, dstIp: null, dstPort: null };
}

export function parseTcpdumpLine(line, bridge, macMap = new Map()) {
  const ethernet = line.match(/^\s*(\d+(?:\.\d+)?)\s+([0-9a-f:]{17})\s*>\s*([0-9a-f:]{17}),\s*(.*)$/i);
  if (!ethernet) return null;
  const srcMac = ethernet[2].toLowerCase();
  const dstMac = ethernet[3].toLowerCase();
  const body = ethernet[4];
  const length = Number(body.match(/\blength\s+(\d+)/i)?.[1] || 0);
  return {
    type: "packet",
    capturedAt: new Date(Number(ethernet[1]) * 1000).toISOString(),
    bridge,
    protocol: protocolOf(body),
    length,
    srcMac,
    dstMac,
    srcDevice: macMap.get(srcMac) || null,
    dstDevice: macMap.get(dstMac) || null,
    ...parseEndpoints(body)
  };
}

async function loadMacMap() {
  const macMap = new Map();
  let ispExternalMac = null;
  await Promise.all([...names].map(async ([vmid, name]) => {
    const { stdout } = await execFileAsync("/usr/sbin/qm", ["config", String(vmid)], { timeout: 5_000 });
    for (const match of stdout.matchAll(/^net(\d+):\s+\w+=([0-9a-f:]{17}),/gim)) {
      const mac = match[2].toLowerCase();
      macMap.set(mac, { vmid, name });
      if (vmid === 100 && match[1] === "0") ispExternalMac = mac;
    }
  }));
  return { macMap, ispExternalMac };
}

class TrafficCapture {
  constructor() {
    this.clients = new Set();
    this.processes = new Map();
    this.macMap = new Map();
    this.sequence = 0;
    this.running = false;
    this.stopTimer = null;
    this.rates = new Map();
    this.keepalive = setInterval(() => {
      for (const client of this.clients) client.write(": keepalive\n\n");
    }, 15_000);
    this.keepalive.unref();
  }

  send(client, payload) {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  publish(payload) {
    const event = { sequence: ++this.sequence, at: new Date().toISOString(), ...payload };
    for (const client of this.clients) this.send(client, event);
  }

  allowPacket(bridge) {
    const second = Math.floor(Date.now() / 1000);
    const rate = this.rates.get(bridge) || { second, count: 0 };
    if (second !== rate.second) Object.assign(rate, { second, count: 0 });
    rate.count += 1;
    this.rates.set(bridge, rate);
    return rate.count <= 12;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      const inventory = await loadMacMap();
      this.macMap = inventory.macMap;
      for (const { bridge, interface: captureInterface } of captureTargets) {
        const filter = bridge === "vmbr0" && inventory.ispExternalMac
          ? `(arp or ip or ip6) and ether host ${inventory.ispExternalMac}`
          : "arp or ip or ip6";
        const child = spawn("/bin/tcpdump", ["-l", "-n", "-e", "-tt", "-q", "-i", captureInterface, filter], {
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        this.processes.set(bridge, child);
        const lines = readline.createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          const event = parseTcpdumpLine(line, bridge, this.macMap);
          if (event && this.allowPacket(bridge)) this.publish(event);
        });
        child.once("exit", (code) => {
          this.processes.delete(bridge);
          if (this.running && code) {
            const detail = stderr.trim().split(/\r?\n/).at(-1);
            this.publish({ type: "capture-error", bridge, message: detail || `tcpdump завершился с кодом ${code}` });
          }
        });
      }
      this.publish({ type: "capture-status", status: "running", bridges });
    } catch (error) {
      this.running = false;
      this.publish({ type: "capture-error", message: error.message });
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    for (const child of this.processes.values()) child.kill("SIGTERM");
    this.processes.clear();
  }

  async addClient(client) {
    clearTimeout(this.stopTimer);
    this.clients.add(client);
    this.send(client, { type: "capture-status", status: this.running ? "running" : "starting", bridges });
    await this.start();
  }

  removeClient(client) {
    this.clients.delete(client);
    if (!this.clients.size) this.stopTimer = setTimeout(() => this.stop(), 2_000);
  }
}

export const trafficCapture = new TrafficCapture();
