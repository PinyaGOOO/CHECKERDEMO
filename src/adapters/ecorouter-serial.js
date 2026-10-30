import net from "node:net";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function cleanTerminalOutput(value) {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[78]/g, "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function stripPagerMarkers(value) {
  return value
    .replace(/--More--(?:\(byte\s+\d+\))?/gi, "")
    .replace(/\[K/g, "");
}

function cliPromptVisible(value) {
  const lines = cleanTerminalOutput(value).split("\n");
  const tail = lines.slice(-3).join("\n").trimEnd();
  return /(?:^|\n)[A-Za-z0-9_.()-]+(?:\([^\n)]*\))?[>#]\s*$/.test(tail);
}

export function parseEcoRouterHostname(value) {
  const cleaned = cleanTerminalOutput(value);
  const configured = cleaned.match(/^\s*hostname\s+(\S+)\s*$/im)?.[1];
  if (configured) return configured;
  const commandOffset = cleaned.toLowerCase().lastIndexOf("show hostname");
  const response = commandOffset >= 0 ? cleaned.slice(commandOffset + "show hostname".length) : cleaned;
  const lines = response.split("\n").map((line) => line.trim()).filter(Boolean);
  const candidates = lines.filter((line) =>
    /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(line)
    && !/^(Password|login|admin|enable|end|exit|quit)$/i.test(line)
  );
  return candidates[0] || null;
}

export class EcoRouterSerialAdapter {
  constructor({ socketDirectory = "/var/run/qemu-server", timeout = 6_000 } = {}) {
    this.socketDirectory = socketDirectory;
    this.timeout = timeout;
    this.runningConfigCache = new Map();
  }

  beginSnapshot() {
    this.runningConfigCache.clear();
  }

  async runCommand(vmid, credentials, command, wait = 900) {
    const socketPath = `${this.socketDirectory}/${vmid}.serial0`;
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk.toString("utf8")));

    const connected = new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const commandTimeout = Math.max(this.timeout, wait + 8_000);
    const timer = setTimeout(() => socket.destroy(new Error("Serial console timeout")), commandTimeout);

    try {
      await connected;
      // Ctrl+C returns a half-entered login/password prompt to a known state,
      // and is harmless when an authenticated CLI prompt is already active.
      socket.write("q\x03\r\n");
      await delay(650);
      let screen = cleanTerminalOutput(chunks.join(""));

      if (/login:\s*$/i.test(screen)) {
        socket.write(`${credentials.username}\r\n`);
        await delay(350);
        screen = cleanTerminalOutput(chunks.join(""));
      }
      if (/Password:\s*$/i.test(screen)) {
        socket.write(`${credentials.password}\r\n`);
        await delay(1_400);
      }

      // A browser console may have been left inside configuration mode.
      // Return to the privileged EXEC prompt before issuing show commands.
      socket.write("end\r\n");
      await delay(250);

      chunks.length = 0;
      socket.write(`${command}\r\n`);
      const startedAt = Date.now();
      let handledPagers = 0;
      let promptSeenAt = null;
      while (Date.now() - startedAt < commandTimeout - 250) {
        await delay(100);
        const output = chunks.join("");
        const pagerCount = (cleanTerminalOutput(output).match(/--More--/gi) || []).length;
        while (handledPagers < pagerCount) {
          socket.write(" ");
          handledPagers += 1;
          promptSeenAt = null;
        }
        if (Date.now() - startedAt >= wait && cliPromptVisible(output)) {
          promptSeenAt ||= Date.now();
          if (Date.now() - promptSeenAt >= 200) break;
        } else {
          promptSeenAt = null;
        }
      }
      return stripPagerMarkers(cleanTerminalOutput(chunks.join("")));
    } finally {
      clearTimeout(timer);
      socket.end();
    }
  }

  async getHostname(vmid, credentials) {
    const output = await this.getRunningConfig(vmid, credentials);
    const hostname = parseEcoRouterHostname(output);
      if (!hostname) throw new Error("EcoRouter did not return hostname");
      return hostname;
  }

  async getIpInterfaceBrief(vmid, credentials) {
    return this.getRunningConfig(vmid, credentials);
  }

  async getNetworkConfiguration(vmid, credentials) {
    return this.getRunningConfig(vmid, credentials);
  }

  async getRunningConfig(vmid, credentials) {
    if (!this.runningConfigCache.has(vmid)) {
      const pending = this.runCommand(vmid, credentials, "show running-config", 2_500)
        .catch((error) => {
          this.runningConfigCache.delete(vmid);
          throw error;
        });
      this.runningConfigCache.set(vmid, pending);
    }
    return this.runningConfigCache.get(vmid);
  }

  async testCredentials(vmid, credentials) {
    const socketPath = `${this.socketDirectory}/${vmid}.serial0`;
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
    const connected = new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const timer = setTimeout(() => socket.destroy(new Error("Serial login timeout")), this.timeout);
    try {
      await connected;
      socket.write("q\x03\r\nend\r\n");
      await delay(350);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const screen = cleanTerminalOutput(chunks.join(""));
        if (/login:\s*$/i.test(screen)) break;
        socket.write("exit\r\n");
        await delay(350);
      }
      let screen = cleanTerminalOutput(chunks.join(""));
      if (!/login:\s*$/i.test(screen)) return false;
      socket.write(`${credentials.username}\r\n`);
      await delay(300);
      socket.write(`${credentials.password}\r\n`);
      await delay(1_000);
      screen = cleanTerminalOutput(chunks.join(""));
      return !/Login incorrect/i.test(screen) && /(?:^|\n)[A-Za-z0-9_.()-]+[>#]\s*$/m.test(screen);
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
}
