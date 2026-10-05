import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { readBalances, valueUsdE18, wireUid, type CanonicalAsset } from "@sama/assets";
import type { Asset, Portfolio } from "@sama/api-types";
import { E18, parseDecimal, type AssetUid } from "@sama/shared";
import { deps } from "./deps.ts";
import { bnbUsd, extraHoldings, type ExtraHolding } from "./holdings.ts";
import { timed } from "./log.ts";

const DISPLAY_TTL_MS = 5_000;
let display: { at: number; prices: Map<AssetUid, bigint> } | undefined;
let inflight: Promise<Map<AssetUid, bigint>> | undefined;

/** Below this raw balance (1e-6 of a token) a holding is dust and is not shown or rebalanced. */
const DUST_RAW = 10n ** 12n;

export const usd = (v: bigint) => Number(v / 10n ** 12n) / 1e6;
export const tokensOf = (raw: bigint) => Number(raw / 10n ** 9n) / 1e9;

const priceE18 = (value: string) => parseDecimal(value.replace(/^(\d+\.\d{18})\d+$/, "$1"), 18);

/**
 * Display prices for every allowlisted asset from one Binance request, cached for five seconds and shared by concurrent
 * callers. USDT is $1. Never used to value money in a round: rounds take their own pinned snapshot.
 */
export async function displayPrices(): Promise<Map<AssetUid, bigint>> {
  if (display && Date.now() - display.at < DISPLAY_TTL_MS) return display.prices;
  inflight ??= (async () => {
    const reg = deps().registry();
    const raw = await deps().fetchPrices(reg.stocks().map((a) => a.contractAddress));
    const prices = new Map<AssetUid, bigint>([[reg.cash().uid, E18]]);
    for (const a of reg.stocks()) {
      const p = raw.get(a.uid);
      if (p) prices.set(a.uid, priceE18(p.tokenPrice));
    }
    display = { at: Date.now(), prices };
    return prices;
  })().finally(() => (inflight = undefined));
  return inflight;
}

export function resetDisplayCache() {
  display = undefined;
}

const DISCLOSURE = "bStock issued by Binance. Each token is backed 1:1 by the underlying share held by Nest Clearing and Custody (ADGM). Sama coordinates the trades you choose; it gives no investment advice and does not decide whether you may trade an asset.";

export function toWireAsset(a: CanonicalAsset, price: bigint | undefined): Asset {
  return {
    uid: wireUid(a),
    address: a.contractAddress,
    symbol: a.symbol,
    name: a.name,
    decimals: a.decimals,
    class: a.class,
    priceUsd: price === undefined ? 0 : usd(price),
    ...(a.class === "CASH" ? {} : { disclosure: DISCLOSURE }),
    tier: a.tier,
    leveraged: a.leveraged,
    uiMultiplier: Number(a.currentMultiplierE18) / 1e18,
    ...(a.logoPath ? { logoUrl: a.logoPath } : {}),
  };
}

/** The asset list the API serves: USDT first, then bStocks by tier and holder count (the allowlist order). */
export async function assetList(): Promise<Asset[]> {
  const reg = deps().registry();
  const prices = await displayPrices().catch(() => new Map<AssetUid, bigint>());
  return [reg.cash(), ...reg.stocks()].map((a) => toWireAsset(a, prices.get(a.uid)));
}

export type Holding = { asset: CanonicalAsset; rawBalance: bigint; priceE18: bigint; valueE18: bigint };

export type LoadedPortfolio =
  | { ok: true; address: Address; holdings: Holding[]; totalE18: bigint; readAt: string; unpriced: string[]; extras: ExtraHolding[]; bnb?: number | undefined }
  | { ok: false; detail: string };

/** Live balances of every allowlisted asset in one multicall, valued at display prices. */
export async function loadPortfolio(input: string): Promise<LoadedPortfolio> {
  if (!isAddress(input, { strict: false })) return { ok: false, detail: `${input} is not an EVM address` };
  const address = getAddress(input);
  const reg = deps().registry();
  const assets = reg.all();
  let balances: Array<bigint | undefined>;
  try {
    balances = await timed("portfolio.balances", () => readBalances(deps().client(), address, assets.map((a) => a.contractAddress)), { tokens: assets.length });
  } catch (error) {
    return { ok: false, detail: `Could not read balances from BNB Chain: ${(error as Error).message.split("\n")[0]}` };
  }
  const held = assets.map((asset, i) => ({ asset, rawBalance: balances[i] ?? 0n })).filter((h) => h.rawBalance > DUST_RAW);
  const prices = held.length ? await displayPrices() : new Map<AssetUid, bigint>();
  const unpriced = held.filter((h) => !prices.has(h.asset.uid)).map((h) => h.asset.symbol);
  const holdings = held
    .filter((h) => prices.has(h.asset.uid))
    .map((h) => {
      const priceE18 = prices.get(h.asset.uid) as bigint;
      return { ...h, priceE18, valueE18: valueUsdE18(h.rawBalance, priceE18) };
    })
    .sort((a, b) => (b.valueE18 > a.valueE18 ? 1 : b.valueE18 < a.valueE18 ? -1 : 0));
  const totalE18 = holdings.reduce((s, h) => s + h.valueE18, 0n);
  const extras = await extraHoldings(address).catch(() => [] as ExtraHolding[]);
  const bnb = extras.some((t) => t.native) ? await bnbUsd() : undefined;
  return { ok: true, address, holdings, totalE18, readAt: new Date().toISOString(), unpriced, extras, bnb };
}

export function toWirePortfolio(p: LoadedPortfolio): Portfolio {
  if (!p.ok) return { ok: false, detail: p.detail };
  // Extra holdings (BNB, listed tokens) are priced only where a source exists; the rest show their amount with no value.
  const extra = p.extras.map((t) => {
    const amountTokens = Number(formatUnits(t.rawBalance, t.decimals));
    const price = t.native ? p.bnb : undefined;
    return { symbol: t.symbol, amountTokens, valueUsd: price === undefined ? 0 : amountTokens * price, logo: t.logo, priced: price !== undefined };
  });
  const registry = p.holdings.map((h) => ({ symbol: h.asset.symbol, amountTokens: tokensOf(h.rawBalance), valueUsd: usd(h.valueE18), logo: "", priced: true }));
  const totalUsd = usd(p.totalE18) + extra.reduce((sum, e) => sum + e.valueUsd, 0);
  const positions = [...registry, ...extra].map((x) => ({ ...x, pct: totalUsd > 0 ? (x.valueUsd / totalUsd) * 100 : 0 }));
  return { ok: true, totalUsd, readAt: p.readAt, positions };
}
