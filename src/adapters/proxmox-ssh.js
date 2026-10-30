import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function parseVmConsoleCredentials(output, preferredUsername = null) {
  const encoded = output.match(/^description:\s*(.+)$/m)?.[1];
  if (!encoded) return null;
  const records = decodeURIComponent(encoded)
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes(":"))
    .map((line) => {
      const separator = line.indexOf(":");
      return { username: line.slice(0, separator), password: line.slice(separator + 1) };
    });
  if (preferredUsername) {
    const preferred = records.find((record) => record.username === preferredUsername);
    if (preferred) return preferred;
  }
  return records[0] || null;
}

export class ProxmoxSshAdapter {
  constructor({ alias = "checker", timeout = 8_000, transport = "ssh" } = {}) {
    this.alias = alias;
    this.timeout = timeout;
    this.transport = transport;
  }

  async execute(command) {
    const executable = this.transport === "local" ? "/bin/sh" : "ssh";
    const args = this.transport === "local"
      ? ["-lc", command]
      : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", this.alias, command];
    const { stdout } = await execFileAsync(executable, args, {
      timeout: this.timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    return stdout.trim();
  }

  async inventory() {
    const output = await this.execute("pvesh get /cluster/resources --type vm --output-format json");
    const resources = JSON.parse(output);
    const vms = resources
      .filter((item) => item.type === "qemu")
      .map((item) => ({
        vmid: item.vmid,
        name: item.name,
        node: item.node,
        status: item.status,
        uptime: item.uptime || 0,
        cpu: item.cpu || 0,
        maxCpu: item.maxcpu || 0,
        memory: item.mem || 0,
        maxMemory: item.maxmem || 0,
        tags: item.tags || ""
      }))
      .sort((left, right) => left.vmid - right.vmid);

    return {
      source: this.transport === "local" ? "proxmox-local" : "proxmox-ssh",
      alias: this.transport === "local" ? null : this.alias,
      node: vms[0]?.node || "unknown",
      fetchedAt: new Date().toISOString(),
      vms
    };
  }

  async guestCommand(vmid, command) {
    if (!Number.isInteger(vmid) || vmid < 100) throw new TypeError("Invalid VMID");
    const allowed = new Set(["ping", "get-host-name", "network-get-interfaces", "get-osinfo"]);
    if (!allowed.has(command)) throw new TypeError(`Unsupported guest command: ${command}`);
    const output = await this.execute(`qm guest cmd ${vmid} ${command}`);
    return output ? JSON.parse(output) : { ok: true };
  }

  async guestExec(vmid, path, args = []) {
    if (!Number.isInteger(vmid) || vmid < 100) throw new TypeError("Invalid VMID");
    if (!path.startsWith("/")) throw new TypeError("Guest executable must use an absolute path");
    const command = ["qm", "guest", "exec", String(vmid), "--", path, ...args]
      .map(shellQuote)
      .join(" ");
    const output = await this.execute(command);
    return JSON.parse(output);
  }

  async vmConsoleCredentials(vmid, { preferredUsername = null } = {}) {
    if (!Number.isInteger(vmid) || vmid < 100) throw new TypeError("Invalid VMID");
    const output = await this.execute(`qm config ${vmid}`);
    const credentials = parseVmConsoleCredentials(output, preferredUsername);
    if (!credentials) throw new Error(`Console credentials are not defined for VM ${vmid}`);
    if (preferredUsername && credentials.username !== preferredUsername) {
      throw new Error(`Console credentials for ${preferredUsername} are not defined for VM ${vmid}`);
    }
    return credentials;
  }
}
