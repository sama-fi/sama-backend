import { erc20Abi, getAddress, type Address, type Hex } from "viem";
import { sessionAt, type AssetTier } from "@sama/assets";
import { bestRoute, bnbUsdE18, buildApprovalTx, buildSwapTx, candidateRoutes, minimumOut, PANCAKESWAP_BSC, PancakeQuoteError, quoteRoutes, routerAllowance, type ScoredQuote } from "@sama/pancakeswap";
import { priceMap } from "@sama/portfolio";
import { decideResidual, routeCost, type ResidualPlan, type RouteCostEstimate } from "@sama/residual";
import type { AssetUid } from "@sama/shared";
import { db, fromJson, toJson } from "./db/client.ts";
import { deps } from "./deps.ts";
import { env } from "./env.ts";
import { RoundError } from "./errors.ts";
import { usd } from "./market.ts";
import { intentsFor, ownFills, type RoundRecord } from "./rounds.ts";
import { key, logActivity } from "./users.ts";

export type ResidualChoice = "CARRY_FORWARD" | "EXECUTE_NOW" | "CANCEL";

export type ResidualItem = { assetUid: AssetUid; token: Address; symbol: string; tier: AssetTier; side: "SELL" | "BUY"; amountRaw: bigint; valueUsd: number; dust: boolean };

/** Residuals are only final once crossing is settled and verified, or nothing crossed. */
export function residualsReady(round: RoundRecord): boolean {
  return round.state === "COMPLETE" || round.state === "NO_CROSS";
}

export function residualItems(round: RoundRecord, owner: Address): ResidualItem[] {
  const reg = deps().registry();
  return ownFills(round, owner)
    .filter((f) => f.residualRaw > 0n)
    .map((f) => {
      const a = reg.getByUid(f.assetUid);
      return { assetUid: f.assetUid, token: f.token, symbol: a.symbol, tier: a.tier, side: f.side, amountRaw: f.residualRaw, valueUsd: usd(f.residualValueUsdE18), dust: f.residualClass === "DUST" };
    });
}

export type Recommendation = {
  pair: { sell: ResidualItem; buy: ResidualItem } | null;
  plan: ResidualPlan | null;
  quote: ScoredQuote | null;
  unavailable: string | null;
};

const TIER_RANK: Record<AssetTier, number> = { A: 0, B: 1, C: 2 };

/**
 * Runs the economic residual engine on the viewer's own leftover: sell leftover into buy leftover through PancakeSwap
 * V3, priced from a live QuoterV2 quote and measured against the round's snapshot prices.
 */
export async function recommend(round: RoundRecord, owner: Address): Promise<Recommendation> {
  const items = residualItems(round, owner).filter((i) => !i.dust);
  const sell = items.find((i) => i.side === "SELL");
  const buy = items.find((i) => i.side === "BUY");
  if (!sell || !buy) return { pair: null, plan: null, quote: null, unavailable: items.length === 0 ? null : "Only one side of your leftover remains, so it can only carry into the next round or be dropped." };

  const intent = (await intentsFor(round.id)).find((e) => getAddress(e.owner) === getAddress(owner))?.intent;
  if (!intent) throw new RoundError("No intent from this wallet in the round.");
  const prices = priceMap(round.snapshot);
  const referenceInUsd = usd((sell.amountRaw * (prices.get(sell.assetUid) ?? 0n)) / 10n ** 18n);
  const tier = TIER_RANK[sell.tier] >= TIER_RANK[buy.tier] ? sell.tier : buy.tier;
  const routes: RouteCostEstimate[] = [];
  let quote: ScoredQuote | null = null;
  if (tier === "A") {
    const client = deps().client();
    const cash = deps().registry().cash().contractAddress;
    const quotes = await quoteRoutes(client, candidateRoutes(sell.token, buy.token, cash), sell.amountRaw);
    if (quotes.length > 0) {
      const [gasPriceWei, bnbUsd] = await Promise.all([client.getGasPrice(), bnbUsdE18(client, cash)]);
      quote = bestRoute(quotes, { outPriceUsdE18: prices.get(buy.assetUid) ?? 0n, gasPriceWei, bnbUsdE18: bnbUsd });
      const gas = usd(quote.gasUsdE18);
      routes.push(routeCost({ venue: "PANCAKESWAP", style: "MARKET", referenceInUsd, referenceOutUsd: usd(quote.outUsdE18), providerFeeUsd: null, networkCostUsd: gas, fixedCostUsd: gas, source: `pancakeswap v3 ${quote.fees.join("/")}`, observedAt: new Date().toISOString() }));
    }
  }
  const plan = decideResidual(
    { urgency: intent.policy.urgency, maxExternalSlippageBps: intent.policy.maxExternalSlippageBps, maxReferencePriceDriftBps: intent.policy.maxReferencePriceDriftBps, allowMarketResidual: intent.policy.allowMarketResidual, allowLimitResidual: false, allowTwapResidual: false, allowWaitResidual: intent.policy.allowWaitResidual },
    { notionalUsd: referenceInUsd, session: sessionAt(new Date(deps().nowSec() * 1000)), tier, tradingHalt: false, referenceDriftBps: 0, routes, twapThresholdUsd: Number.POSITIVE_INFINITY, nextRoundAvailable: true },
  );
  return { pair: { sell, buy }, plan, quote, unavailable: null };
}

export type StoredDecision = { assetUid: string; side: string; amountRaw: string; engineDecision: string; userChoice: ResidualChoice; detail: Record<string, unknown>; consumedRoundId: string | null };

export async function decisionsFor(roundId: string, owner: Address): Promise<StoredDecision[]> {
  const rows = await (await db()).query<{ asset_uid: string; side: string; amount_raw: string; engine_decision: string; user_choice: string; detail: unknown; consumed_round_id: string | null }>("select * from residual_decisions where round_id = $1 and owner = $2", [roundId, key(owner)]);
  return rows.map((r) => ({ assetUid: r.asset_uid, side: r.side, amountRaw: r.amount_raw, engineDecision: r.engine_decision, userChoice: r.user_choice as ResidualChoice, detail: fromJson(r.detail), consumedRoundId: r.consumed_round_id }));
}

async function store(round: RoundRecord, owner: Address, items: ResidualItem[], engineDecision: string, choice: ResidualChoice, detail: Record<string, unknown>) {
  const d = await db();
  for (const i of items) {
    await d.query(
      `insert into residual_decisions (round_id, owner, asset_uid, side, amount_raw, engine_decision, user_choice, detail) values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)
       on conflict (round_id, owner, asset_uid) do update set user_choice = excluded.user_choice, engine_decision = excluded.engine_decision, detail = excluded.detail, decided_at = now()`,
      [round.id, key(owner), i.assetUid, i.side, i.amountRaw.toString(), engineDecision, choice, toJson(detail)],
    );
  }
}

/** Carry forward or cancel. Carried leftovers come back on their own: the next round rebuilds the intent from the same target. */
export async function decide(round: RoundRecord, owner: Address, choice: Exclude<ResidualChoice, "EXECUTE_NOW">, engineDecision: string) {
  if (!residualsReady(round)) throw new RoundError("Leftovers are decided after the round settles.");
  const items = residualItems(round, owner);
  if (items.length === 0) throw new RoundError("You have no leftover in this round.");
  await store(round, owner, items, engineDecision, choice, {});
  await logActivity(owner, "RESIDUAL_DECIDED", { choice, assets: items.map((i) => `${i.side} ${i.symbol}`).join(", ") }, { roundId: round.id, circleId: round.circleId });
}

/** Quotes live in the database, not process memory: consecutive steps of one swap may run on different instances. */
const QUOTE_TTL_SEC = 60;

type StoredQuote = { path: Hex; amountIn: bigint; amountOut: bigint; minimumOut: bigint; sell: Address; buy: Address };

export type SwapTxWire = { to: Address; data: Hex; value: string; gasLimit?: string };

/**
 * Step one of a leftover swap from the user's own wallet: the exact-amount approval for the PancakeSwap router if one is
 * missing, otherwise a fresh quote stored for the build step. Only a route the engine accepted is executable.
 */
export async function swapPrepare(round: RoundRecord, owner: Address): Promise<{ approval: SwapTxWire | null; permitData: null; amountOut: string | null; minimumOut: string | null }> {
  if (!residualsReady(round)) throw new RoundError("Leftovers are swapped after the round settles.");
  const rec = await recommend(round, owner);
  if (!rec.pair) throw new RoundError(rec.unavailable ?? "No leftover pair to swap.");
  if (!rec.quote || rec.plan?.decision !== "EXECUTE_NOW") throw new RoundError(rec.plan?.reasons.join(" ") || "PancakeSwap has no route for this leftover right now.");
  const allowance = await routerAllowance(deps().client(), rec.pair.sell.token, owner);
  if (allowance < rec.pair.sell.amountRaw) {
    const tx = buildApprovalTx(rec.pair.sell.token, rec.pair.sell.amountRaw);
    return { approval: { to: tx.to, data: tx.data, value: "0" }, permitData: null, amountOut: null, minimumOut: null };
  }
  const min = minimumOut(rec.quote.amountOut, env().swapSlippageBps);
  const stored: StoredQuote = { path: rec.quote.path, amountIn: rec.quote.amountIn, amountOut: rec.quote.amountOut, minimumOut: min, sell: rec.pair.sell.token, buy: rec.pair.buy.token };
  await (await db()).query(
    "insert into residual_quotes (round_id, owner, quote) values ($1, $2, $3::text::jsonb) on conflict (round_id, owner) do update set quote = excluded.quote, created_at = now()",
    [round.id, key(owner), toJson(stored)],
  );
  return { approval: null, permitData: null, amountOut: rec.quote.amountOut.toString(), minimumOut: min.toString() };
}

/** Re-quotes; a fresh quote below the stored minimum is refused rather than sent with a looser bound. */
export async function swapBuild(round: RoundRecord, owner: Address): Promise<SwapTxWire> {
  const [row] = await (await db()).query<{ quote: unknown; created_at: Date }>("select quote, created_at from residual_quotes where round_id = $1 and owner = $2", [round.id, key(owner)]);
  if (!row || deps().nowSec() - Math.floor(new Date(row.created_at).getTime() / 1000) > QUOTE_TTL_SEC) throw new RoundError("The quote expired. Get a fresh quote.");
  const stored = fromJson<StoredQuote>(row.quote);
  const [fresh] = await quoteRoutes(deps().client(), [{ tokens: [stored.sell, stored.buy], fees: [], path: stored.path }], stored.amountIn);
  if (!fresh) throw new PancakeQuoteError("the stored route no longer quotes");
  if (fresh.amountOut < stored.minimumOut) throw new RoundError("The price moved past your slippage limit since the quote. Get a fresh quote.");
  const deadline = deps().nowSec() + 300;
  const tx = buildSwapTx({ path: stored.path, recipient: owner, amountIn: stored.amountIn, amountOutMinimum: stored.minimumOut, deadline });
  const gas = await deps().client().estimateGas({ account: owner, to: tx.to, data: tx.data }).catch(() => fresh.gasEstimate + 150_000n);
  return { to: tx.to, data: tx.data, value: "0", gasLimit: ((gas * 12n) / 10n).toString() };
}

/** Confirms the swap from chain data: receipt, router target, and the owner's balance change in both tokens. */
export async function swapRecord(round: RoundRecord, owner: Address, txHash: Hex) {
  const [row] = await (await db()).query<{ quote: unknown }>("select quote from residual_quotes where round_id = $1 and owner = $2", [round.id, key(owner)]);
  if (!row) throw new RoundError("No pending swap for this round.");
  const stored = fromJson<StoredQuote>(row.quote);
  const rpc = deps().client();
  const [receipt, tx] = await Promise.all([rpc.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 }), rpc.getTransaction({ hash: txHash })]);
  if (!tx.to || getAddress(tx.to) !== getAddress(PANCAKESWAP_BSC.smartRouter)) throw new RoundError("That transaction is not a PancakeSwap router call.");
  if (getAddress(tx.from) !== getAddress(owner)) throw new RoundError("That transaction was not sent by your wallet.");
  const balance = (token: Address, blockNumber: bigint) => rpc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber });
  const [inBefore, inAfter, outBefore, outAfter] = await Promise.all([balance(stored.sell, receipt.blockNumber - 1n), balance(stored.sell, receipt.blockNumber), balance(stored.buy, receipt.blockNumber - 1n), balance(stored.buy, receipt.blockNumber)]);
  const received = outAfter - outBefore;
  const ok = receipt.status === "success" && received >= stored.minimumOut;
  const detail = { venue: "PANCAKESWAP_V3", txHash, receiptStatus: receipt.status, block: receipt.blockNumber, spentRaw: inBefore - inAfter, receivedRaw: received, minimumOut: stored.minimumOut, ok };
  const items = residualItems(round, owner).filter((i) => !i.dust && (getAddress(i.token) === getAddress(stored.sell) || getAddress(i.token) === getAddress(stored.buy)));
  await store(round, owner, items, "EXECUTE_NOW", "EXECUTE_NOW", detail);
  await (await db()).query("delete from residual_quotes where round_id = $1 and owner = $2", [round.id, key(owner)]);
  await logActivity(owner, "RESIDUAL_DECIDED", { choice: "EXECUTE_NOW", txHash, receiptStatus: receipt.status }, { roundId: round.id, circleId: round.circleId });
  if (!ok) throw new RoundError(receipt.status === "success" ? "The swap returned less than the minimum. It is recorded; check your wallet." : "The swap reverted. Nothing moved.");
  return detail;
}
