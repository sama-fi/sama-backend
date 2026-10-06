import { readBalances } from "@sama/assets";
import { listedToken, type ListedToken } from "@sama/tokens";
import { type Address } from "viem";
import { db } from "./db/client.ts";
import { deps } from "./deps.ts";
import { bnbUsd } from "./spot.ts";
import { key } from "./users.ts";

/**
 * Holdings outside the asset registry: native BNB (always shown, like USDT) and every token that has moved through a
 * user's wallet and is named by PancakeSwap's list. Unlisted tokens stay hidden, so spam airdrops do not fill the list.
 */
export const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as const;

export type ExtraHolding = { address: Address; symbol: string; decimals: number; logo: string; rawBalance: bigint; native: boolean };

export { bnbUsd };

export async function extraHoldings(owner: Address): Promise<ExtraHolding[]> {
  const client = deps().client();
  const registry = new Set(deps().registry().all().map((a) => a.contractAddress.toLowerCase()));
  const moved = await (await db()).query<{ token: string }>("select distinct token from transfers where to_addr = $1 or from_addr = $1", [key(owner)]);

  const listed: Array<{ address: Address; meta: ListedToken }> = [];
  for (const { token } of moved) {
    const address = token.toLowerCase();
    if (registry.has(address)) continue;
    const meta = await listedToken(address);
    if (meta) listed.push({ address: address as Address, meta });
  }

  const balances = listed.length ? await readBalances(client, owner, listed.map((l) => l.address)) : [];
  const tokens: ExtraHolding[] = listed.map((l, i) => ({
    address: l.address,
    symbol: l.meta.symbol,
    decimals: l.meta.decimals,
    logo: l.meta.logoURI,
    rawBalance: balances[i] ?? 0n,
    native: false,
  }));
  tokens.sort((a, b) => (a.rawBalance === b.rawBalance ? 0 : a.rawBalance > b.rawBalance ? -1 : 1));

  const bnb = await client.getBalance({ address: owner });
  const wrapped = await listedToken(WBNB);
  return [{ address: WBNB, symbol: "BNB", decimals: 18, logo: wrapped?.logoURI ?? "", rawBalance: bnb, native: true }, ...tokens.filter((t) => t.rawBalance > 0n)];
}
