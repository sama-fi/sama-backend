import { log } from "./log.ts";

/**
 * PancakeSwap's extended token list for BSC: symbol, decimals and logo for the tokens people actually hold. It is the
 * only source of names and logos for tokens outside Sama's registry. Refetched hourly; if the fetch fails the last good
 * copy stays in use, and an empty map means tokens show as UNKNOWN until the next try.
 */
const LIST_URL = "https://tokens.pancakeswap.finance/pancakeswap-extended.json";
const TTL_MS = 60 * 60_000;

export type ListedToken = { symbol: string; name: string; decimals: number; logoURI: string };

let entries = new Map<string, ListedToken>();
let fetchedAt = 0;
let inflight: Promise<void> | undefined;

async function refresh() {
  try {
    const response = await fetch(LIST_URL, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { tokens?: Array<{ chainId: number; address: string; symbol: string; name: string; decimals: number; logoURI?: string }> };
    const next = new Map<string, ListedToken>();
    for (const t of body.tokens ?? []) {
      if (t.chainId !== 56) continue;
      next.set(t.address.toLowerCase(), { symbol: t.symbol, name: t.name, decimals: t.decimals, logoURI: t.logoURI ?? "" });
    }
    if (next.size > 0) entries = next;
    fetchedAt = Date.now();
    log("tokenlist.loaded", { tokens: entries.size });
  } catch (error) {
    log("tokenlist.failed", { error: (error as Error).message.split("\n")[0] }, "error");
    fetchedAt = Date.now() - TTL_MS + 5 * 60_000; // retry in five minutes, keep the old copy meanwhile
  }
}

/** Looks up a token by address. Never throws: a failed list must not stop transfer recording. */
export async function listedToken(address: string): Promise<ListedToken | undefined> {
  if (Date.now() - fetchedAt > TTL_MS) {
    inflight ??= refresh().finally(() => (inflight = undefined));
    if (entries.size === 0) await inflight;
  }
  return entries.get(address.toLowerCase());
}
