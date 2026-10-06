import type { RwaPrice } from "@sama/binance";
/** BNB's spot price, shared by the wallet view and the price snapshot. */
let bnbPrice: { at: number; usd: number } | undefined;

/** BNB's USD price from Binance's public ticker (no key). Cached a minute; undefined if Binance does not answer. */
export async function bnbUsd(): Promise<number | undefined> {
  if (bnbPrice && Date.now() - bnbPrice.at < 60_000) return bnbPrice.usd;
  try {
    const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return undefined;
    const usd = Number(((await response.json()) as { price: string }).price);
    if (!Number.isFinite(usd) || usd <= 0) return undefined;
    bnbPrice = { at: Date.now(), usd };
    return usd;
  } catch {
    return undefined;
  }
}

export const WBNB_ADDRESS = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

/**
 * Adds WBNB to a Binance RWA price map from BNB's spot price, in the same shape, so the snapshot values it like any
 * other asset (and still checks it against its PancakeSwap TWAP). Left out when Binance's ticker does not answer.
 */
export async function withBnbPrice(prices: Map<string, RwaPrice>, requested: readonly string[]): Promise<Map<string, RwaPrice>> {
  if (!requested.some((a) => a.toLowerCase() === WBNB_ADDRESS)) return prices;
  const price = await bnbUsd();
  if (price === undefined) return prices;
  const text = price.toFixed(8);
  prices.set(WBNB_ADDRESS, { tokenContractAddress: WBNB_ADDRESS, platformId: "crypto", tokenPrice: text, referencePrice: text, updatedAtMs: bnbPrice?.at ?? Date.now() });
  return prices;
}
