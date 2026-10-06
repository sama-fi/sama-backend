import { isAddress } from "viem";
import { HISTORY_RANGES, priceHistory, recentTrades, tokenMarket } from "@sama/market";
import type { HistoryPoint, HistoryRange, MarketStats, Trade } from "@sama/api-types";
import { deps } from "./deps.ts";
import { InputError, NotFoundError } from "./errors.ts";

/**
 * Chart, size and trades for an asset Sama lists. The token is named by address or symbol and must be in the
 * allowlist: this is not a window onto every token GeckoTerminal knows, and a lookalike from another issuer is a 404.
 */
function listedToken(id: string): string {
  const registry = deps().registry();
  const asset = isAddress(id, { strict: false }) ? (registry.isCanonicalAddress(id) ? registry.requireCanonicalAddress(id) : undefined) : registry.findSymbol(id);
  if (!asset) throw new NotFoundError("Sama does not list that token.");
  return asset.contractAddress;
}

export const tokenStats = (id: string): Promise<MarketStats> => tokenMarket(deps().market(), listedToken(id));

export function parseRange(value: string | undefined): HistoryRange {
  if (value === undefined) return "1D";
  if (!(HISTORY_RANGES as string[]).includes(value)) throw new InputError(`range must be one of ${HISTORY_RANGES.join(", ")}.`);
  return value as HistoryRange;
}

export const tokenHistory = (id: string, range: HistoryRange): Promise<HistoryPoint[]> => priceHistory(deps().market(), listedToken(id), range);

export const tokenTrades = (id: string): Promise<Trade[]> => recentTrades(deps().market(), listedToken(id));
