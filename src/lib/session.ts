import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { jwtVerify, SignJWT } from "jose";
import { getAddress, type Address } from "viem";
import { env } from "./env.ts";
import { AuthError } from "./errors.ts";

export const SESSION_COOKIE = "sama_session";
const TTL_SEC = 7 * 24 * 3_600;

export type Session = { address: Address; privyUserId: string | null; walletKind: string };

/** HS256 key for the session cookie. SESSION_SECRET in production; otherwise generated once beside the local database. */
function sessionKey(): Uint8Array {
  const e = env();
  if (e.sessionSecret) return new TextEncoder().encode(e.sessionSecret);
  if (e.production) throw new Error("SESSION_SECRET is required in production.");
  const dir = e.pgliteDir.startsWith("memory://") ? resolve(process.cwd(), ".sama-db") : resolve(process.cwd(), e.pgliteDir);
  const file = resolve(dir, "session.secret");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, randomBytes(48).toString("base64url"), { mode: 0o600 });
  }
  return new TextEncoder().encode(readFileSync(file, "utf8").trim());
}

export async function sessionCookie(session: Session): Promise<string> {
  const jwt = await new SignJWT({ ...session }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${TTL_SEC}s`).sign(sessionKey());
  return cookieString(jwt, TTL_SEC);
}

export function clearedSessionCookie(): string {
  return cookieString("", 0);
}

/** SameSite=Lax when the app and API share a site (localhost:3200 -> :3300, app. -> api.); None; Partitioned across sites. */
function cookieString(value: string, maxAge: number): string {
  const e = env();
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", `Max-Age=${maxAge}`];
  if (e.crossSiteCookie) parts.push("SameSite=None", "Secure", "Partitioned");
  else {
    parts.push("SameSite=Lax");
    if (e.production) parts.push("Secure");
  }
  return parts.join("; ");
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export async function getSession(request: Request): Promise<Session | undefined> {
  const raw = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!raw) return undefined;
  try {
    const { payload } = await jwtVerify<Session>(raw, sessionKey(), { algorithms: ["HS256"] });
    return { address: getAddress(payload.address), privyUserId: payload.privyUserId ?? null, walletKind: payload.walletKind };
  } catch {
    return undefined;
  }
}

export async function requireSession(request: Request): Promise<Session> {
  const session = await getSession(request);
  if (!session) throw new AuthError("Sign in to continue.");
  return session;
}
