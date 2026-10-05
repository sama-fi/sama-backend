import { AsyncLocalStorage } from "node:async_hooks";

type Context = { requestId: string; user?: string };
export const requestContext = new AsyncLocalStorage<Context>();

const SECRET_KEY = /(private|secret|password|apikey|api_key|token|cookie|signature_material|mnemonic|authorization)/i;

/**
 * One JSON line per event with the current request id. Callers pass only safe fields: addresses, round ids, tx hashes,
 * provider hosts, statuses. Keys that look like secrets are redacted as a second line of defence.
 */
export function log(event: string, fields: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info") {
  if (process.env.SAMA_LOG === "silent") return;
  const ctx = requestContext.getStore();
  const safe = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : v]));
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, requestId: ctx?.requestId, user: ctx?.user, ...safe }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Measures an async step and logs its duration, so slow paths show up in logs. */
export async function timed<T>(step: string, fn: () => Promise<T>, fields: Record<string, unknown> = {}): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    log("timing", { step, ms: Math.round(performance.now() - start), ...fields });
  }
}

/** Host of an RPC URL without path or query, which may carry an API key. */
export function providerHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
