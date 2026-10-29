import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";

const sessions = new Map();
const attempts = new Map();
const sessionLifetime = 60 * 60 * 1000;

function clientAddress(request) {
  return request.socket.remoteAddress || "unknown";
}

function allowAttempt(request) {
  const address = clientAddress(request);
  const now = Date.now();
  const record = attempts.get(address) || { since: now, count: 0 };
  if (now - record.since > 5 * 60 * 1000) Object.assign(record, { since: now, count: 0 });
  record.count += 1;
  attempts.set(address, record);
  return record.count <= 5;
}

export function verifyRootPassword(password) {
  if (typeof password !== "string" || password.length < 1 || password.length > 256) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn("/bin/pamtester", ["login", "root", "authenticate"], {
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 10_000
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
    child.stdin.end(`${password}\n`);
  });
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const separator = item.indexOf("=");
    return separator < 0 ? [item, ""] : [item.slice(0, separator), decodeURIComponent(item.slice(separator + 1))];
  }));
}

export function createSession(request) {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { token, address: clientAddress(request), expiresAt: Date.now() + sessionLifetime });
  return token;
}

export function sessionFromRequest(request) {
  const token = parseCookies(request).console_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  const supplied = Buffer.from(token);
  const expected = Buffer.from(session.token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  session.expiresAt = Date.now() + sessionLifetime;
  return session;
}

export function deleteSession(token) {
  sessions.delete(token);
}

export function loginAllowed(request) {
  return allowAttempt(request);
}

export function sessionCookie(token) {
  return `console_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`;
}

export const expiredSessionCookie = "console_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
