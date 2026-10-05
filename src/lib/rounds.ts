import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, keccak256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { intentFromPreview, resolveGoal } from "@sama/agent";
import { TRANSITIONS, type RoundState } from "@sama/circles";
import { matchRound, type MatchResult } from "@sama/matcher";
import { capturePrices, type ExcludedAsset } from "@sama/oracle";
import { buildValuationSnapshot, hashValuationSnapshot, priceMap, type PortfolioIntent, type ValuationSnapshot } from "@sama/portfolio";
import { approvalNonce, approvalTypedData, buildSettlementPlan, hashContractPlan, intentTypedData, preflightSettlement, requiredOutflows, samaSettlementAbi, verifyIntentSignature, type ContractPlan, type SettlementPlan } from "@sama/settlement";
import type { AssetUid } from "@sama/shared";
import { verifySettlement, type SettlementVerification } from "@sama/verifier";
import { getCircle, membership, type CircleRecord } from "./circles.ts";
import { db, fromJson, toJson } from "./db/client.ts";
import { deps, type Providers } from "./deps.ts";
import { env } from "./env.ts";
import { NotFoundError, RoundError } from "./errors.ts";
import { log } from "./log.ts";
import { loadPortfolio, tokensOf, usd } from "./market.ts";
import { policyFor, resolveContext, specFromTarget } from "./targets.ts";
import { ensureUser, getTarget, key, logActivity } from "./users.ts";

/** Rounds in these states are finished: a member entering the lobby gets a fresh round instead. */
export const TERMINAL: ReadonlySet<RoundState> = new Set(["COMPLETE", "EXPIRED", "INSUFFICIENT_PARTICIPANTS", "NO_CROSS", "PLAN_REJECTED", "PLAN_STALE", "SETTLEMENT_REVERTED", "VERIFICATION_FAILED", "CANCELLED"]);
/** Participants have this long after the solve to approve and settle before the plan expires. */
export const APPROVAL_WINDOW_SEC = 1_800;
/** A settlement step idle this long is assumed to belong to a request that died; the next reader resumes it. */
const RESUME_AFTER_SEC = 20;

export type SnapshotMeta = { excluded: ExcludedAsset[]; session: string; independent: boolean; blockNumber: bigint };

export type RoundRecord = {
  id: Hex;
  circleId: Hex;
  sequence: number;
  state: RoundState;
  opensAt: number;
  freezesAt: number;
  chainId: number;
  settlementContract: Address;
  snapshot: ValuationSnapshot;
  snapshotHash: Hex;
  snapshotMeta: SnapshotMeta;
  match: MatchResult | null;
  plan: SettlementPlan | null;
  settlementTx: Hex | null;
  verification: (SettlementVerification & { providers?: Providers }) | null;
  history: Array<{ at: number; from: RoundState; to: RoundState; reason: string | null }>;
};

type RoundRow = { id: string; circle_id: string; sequence: number; state: string; opens_at: string | number; freezes_at: string | number; chain_id: number; settlement_contract: string; snapshot: unknown; snapshot_hash: string; snapshot_meta: unknown; match: unknown; plan: unknown; settlement_tx: string | null; verification: unknown };

const now = () => deps().nowSec();

async function hydrate(row: RoundRow): Promise<RoundRecord> {
  const history = await (await db()).query<{ at: string | number; from_state: string; to_state: string; reason: string | null }>("select * from round_history where round_id = $1 order by id", [row.id]);
  return {
    id: row.id as Hex,
    circleId: row.circle_id as Hex,
    sequence: row.sequence,
    state: row.state as RoundState,
    opensAt: Number(row.opens_at),
    freezesAt: Number(row.freezes_at),
    chainId: row.chain_id,
    settlementContract: getAddress(row.settlement_contract),
    snapshot: fromJson<ValuationSnapshot>(row.snapshot),
    snapshotHash: row.snapshot_hash as Hex,
    snapshotMeta: fromJson<SnapshotMeta>(row.snapshot_meta),
    match: row.match ? fromJson<MatchResult>(row.match) : null,
    plan: row.plan ? fromJson<SettlementPlan>(row.plan) : null,
    settlementTx: row.settlement_tx as Hex | null,
    verification: row.verification ? fromJson<SettlementVerification & { providers?: Providers }>(row.verification) : null,
    history: history.map((h) => ({ at: Number(h.at), from: h.from_state as RoundState, to: h.to_state as RoundState, reason: h.reason })),
  };
}

export async function getRound(id: string): Promise<RoundRecord> {
  const [row] = await (await db()).query<RoundRow>("select * from rounds where id = $1", [id]);
  if (!row) throw new NotFoundError("This round does not exist.");
  return hydrate(row);
}

export async function roundsForCircle(circleId: string): Promise<RoundRecord[]> {
  const rows = await (await db()).query<RoundRow>("select * from rounds where circle_id = $1 order by sequence desc", [circleId]);
  return Promise.all(rows.map(hydrate));
}

type Transitioned = RoundRecord & { moved: boolean };

/** Guarded state change: the circles TRANSITIONS table, applied with a compare-and-set on the stored state. */
async function transition(round: RoundRecord, to: RoundState, reason?: string, patch: Record<string, unknown> = {}): Promise<Transitioned> {
  if (!TRANSITIONS[round.state].includes(to)) throw new RoundError(`Round is ${round.state} and cannot move to ${to}.`);
  const columns = Object.keys(patch);
  const sets = columns.map((c, i) => `${c} = $${i + 4}${c === "match" || c === "plan" || c === "verification" ? "::text::jsonb" : ""}`);
  const moved = await (await db()).tx(async (t) => {
    const rows = await t.query(`update rounds set state = $2${sets.length ? `, ${sets.join(", ")}` : ""} where id = $1 and state = $3 returning id`, [round.id, to, round.state, ...columns.map((c) => patch[c])]);
    if (rows.length === 0) return false;
    await t.query("insert into round_history (round_id, at, from_state, to_state, reason) values ($1, $2, $3, $4, $5)", [round.id, now(), round.state, to, reason ?? null]);
    return true;
  });
  log(moved ? "round.transition" : "round.transition_lost_race", { round: round.id, from: round.state, to, reason: reason ?? null }, moved ? "info" : "warn");
  return { ...(await getRound(round.id)), moved };
}

/**
 * One pinned valuation for the circle's assets: Binance prices, BEP-8056 multipliers read on-chain at one block, tier A
 * cross-checked against PancakeSwap TWAPs. Assets that fail a check are excluded with a reason; fewer than two priced
 * assets means nothing can cross, so the round does not open.
 */
async function captureSnapshot(circle: CircleRecord): Promise<{ snapshot: ValuationSnapshot; meta: SnapshotMeta }> {
  const reg = deps().registry();
  const assets = circle.assetUids.filter((u) => reg.has(u)).map((u) => reg.getByUid(u));
  const t = now();
  const captured = await capturePrices({ client: deps().client(), fetchPrices: deps().fetchPrices, fetchStatus: deps().fetchStatus }, assets, reg.cash(), t, circle.durationSec + APPROVAL_WINDOW_SEC);
  if (captured.prices.length < 2) {
    const why = captured.excluded.map((e) => `${e.symbol}: ${e.reason}`).join("; ");
    throw new RoundError(`Fewer than two of this circle's assets can be priced right now, so nothing could cross.${why ? ` ${why}.` : ""}`);
  }
  return {
    snapshot: buildValuationSnapshot(captured.prices, t, circle.durationSec + APPROVAL_WINDOW_SEC),
    meta: { excluded: captured.excluded, session: captured.session, independent: captured.independent, blockNumber: captured.blockNumber },
  };
}

/** The lobby entry point: the circle's live round, or a new one opened now with a fresh snapshot. */
export async function currentOrOpenRound(circleId: string, viewer: Address): Promise<RoundRecord> {
  if (!(await membership(circleId, viewer))) throw new RoundError("Join this circle before entering its round.");
  const [latest] = await roundsForCircle(circleId);
  if (latest && !TERMINAL.has(latest.state)) return advance(latest);
  const circle = await getCircle(circleId);
  const { snapshot, meta } = await captureSnapshot(circle);
  const sequence = (latest?.sequence ?? 0) + 1;
  const id = keccak256(stringToHex(`sama:round:${circleId}:${sequence}:${snapshot.capturedAt}`));
  const opensAt = now();
  await (await db()).query(
    `insert into rounds (id, circle_id, sequence, state, opens_at, freezes_at, chain_id, settlement_contract, snapshot, snapshot_hash, snapshot_block, snapshot_meta)
     values ($1, $2, $3, 'OPEN', $4, $5, $6, $7, $8::text::jsonb, $9, $10, $11::text::jsonb) on conflict (circle_id, sequence) do nothing`,
    [id, circleId, sequence, opensAt, opensAt + circle.durationSec, env().chainId, env().settlementContract, toJson(snapshot), hashValuationSnapshot(snapshot), meta.blockNumber.toString(), toJson(meta)],
  );
  const [created] = await roundsForCircle(circleId);
  return created as RoundRecord;
}

export async function intentsFor(roundId: string): Promise<Array<{ owner: Address; intent: PortfolioIntent; signature: Hex }>> {
  const rows = await (await db()).query<{ owner: string; intent: unknown; signature: string }>("select owner, intent, signature from intents where round_id = $1 order by owner", [roundId]);
  return rows.map((r) => ({ owner: getAddress(r.owner), intent: fromJson<PortfolioIntent>(r.intent), signature: r.signature as Hex }));
}

/**
 * Moves a round forward on read and from the cron loop: freezes and solves when its window closes (or every member has
 * signed), expires a plan nobody settled in time, and resumes a settlement whose request died mid-way.
 */
export async function advance(round: RoundRecord): Promise<RoundRecord> {
  const t = now();
  if (round.state === "OPEN" || round.state === "COLLECTING") {
    const circle = await getCircle(round.circleId);
    const signed = (await intentsFor(round.id)).length;
    const everyoneSigned = signed >= circle.minParticipants && signed >= circle.memberCount;
    if (t >= round.freezesAt || everyoneSigned) return solve(round, everyoneSigned && t < round.freezesAt ? "every member signed" : "collection window closed");
  }
  if ((round.state === "PROPOSED" || round.state === "APPROVING" || round.state === "READY_TO_SETTLE") && round.plan && BigInt(t) > round.plan.contractPlan.validUntil) {
    return transition(round, "PLAN_STALE", "approval window closed before settlement");
  }
  const lastStep = round.history.at(-1)?.at ?? 0;
  const pending = round.state === "SETTLING" || ((round.state === "SETTLED" || round.state === "VERIFYING") && t - lastStep > RESUME_AFTER_SEC);
  if (pending) {
    try {
      return await completeSettlement(round);
    } catch (error) {
      log("settlement.resume_failed", { round: round.id, state: round.state, error: (error as Error).message.split("\n")[0] }, "error");
      return getRound(round.id);
    }
  }
  return round;
}

/** Cron: advance every round that is not finished. */
export async function advanceActiveRounds(): Promise<number> {
  const rows = await (await db()).query<{ id: string }>(`select id from rounds where state not in (${[...TERMINAL].map((s) => `'${s}'`).join(", ")})`);
  for (const { id } of rows) {
    try {
      await advance(await getRound(id));
    } catch (error) {
      log("cron.advance_failed", { round: id, error: (error as Error).message.split("\n")[0] }, "warn");
    }
  }
  return rows.length;
}

function roundUniverse(round: RoundRecord, circle: CircleRecord): Map<AssetUid, Address> {
  const reg = deps().registry();
  const excluded = new Set(round.snapshotMeta.excluded.map((e) => e.assetUid));
  return new Map(circle.assetUids.filter((u) => reg.has(u) && !excluded.has(u as AssetUid)).map((u) => [u as AssetUid, reg.getByUid(u).contractAddress]));
}

async function solve(round: RoundRecord, reason: string): Promise<RoundRecord> {
  const circle = await getCircle(round.circleId);
  const entries = await intentsFor(round.id);
  if (entries.length === 0) return transition(round, "EXPIRED", "no member signed an intent");
  // Only the request that froze the round solves it; concurrent readers return the current state.
  const frozen = await transition(round, "FROZEN", reason);
  if (!frozen.moved) return frozen;
  const r = await transition(frozen, "SOLVING");
  if (!r.moved) return r;
  if (entries.length < circle.minParticipants) return transition(r, "INSUFFICIENT_PARTICIPANTS", `${entries.length} signed, circle needs ${circle.minParticipants}`);
  const t = now();
  const match = matchRound({ roundId: r.id, snapshot: r.snapshot, intents: entries.map((e) => e.intent), universe: roundUniverse(r, circle), nowSec: t });
  const matchJson = toJson(match);
  if (match.status === "PLAN_STALE") return transition(r, "PLAN_STALE", match.statusReasons.join("; "), { match: matchJson });
  if (match.status === "INSUFFICIENT_PARTICIPANTS") return transition(r, "INSUFFICIENT_PARTICIPANTS", match.statusReasons.join("; "), { match: matchJson });
  if (match.status === "NO_CROSS") {
    const done = await transition(r, "NO_CROSS", "no crossing flow exists among the signed intents", { match: matchJson });
    if (done.moved) for (const e of entries) await logActivity(e.owner, "ROUND_NO_CROSS", { circle: circle.name, sequence: r.sequence }, { roundId: r.id, circleId: r.circleId });
    return done;
  }
  const plan = buildSettlementPlan(match, { settlementContract: r.settlementContract, validAfter: t - 60, validUntil: t + APPROVAL_WINDOW_SEC, generatedAt: t, chainId: r.chainId });
  const proposed = await transition(r, "PROPOSED", `${match.status}: ${match.legs.length} legs`, { match: matchJson, plan: toJson(plan) });
  if (!proposed.moved) return proposed;
  const crossedUsd = usd(match.totals.crossedNotionalUsdE18);
  if (crossedUsd > env().maxPlanUsd) {
    return transition(proposed, "PLAN_REJECTED", `crossed value $${crossedUsd.toFixed(2)} is above the $${env().maxPlanUsd} limit that applies while the settlement contract is unaudited`);
  }
  for (const e of entries) await logActivity(e.owner, "ROUND_MATCHED", { status: match.status, circle: circle.name, sequence: r.sequence }, { roundId: r.id, circleId: r.circleId });
  return proposed;
}

/** Organizer closes collection early (for example once the expected members have signed). */
export async function closeCollection(roundId: string, organizer: Address): Promise<RoundRecord> {
  const round = await getRound(roundId);
  if ((await membership(round.circleId, organizer)) !== "ORGANIZER") throw new RoundError("Only the organizer can close collection early.");
  if (round.state !== "OPEN" && round.state !== "COLLECTING") throw new RoundError(`Round is ${round.state}, collection is already closed.`);
  return solve(round, "organizer closed collection");
}

export type PreparedIntent = { intent: PortfolioIntent; rows: Array<{ symbol: string; side: "SELL" | "BUY"; amountTokens: number; valueUsd: number }>; outsideCircle: string[]; warnings: string[] };

/**
 * Builds the viewer's unsigned intent from their saved target, their live balances and the round's snapshot prices.
 * Only the circle's priced assets enter the intent; drift in other assets is reported, not traded.
 */
export async function prepareIntent(roundId: string, owner: Address): Promise<PreparedIntent> {
  const round = await getRound(roundId);
  if (round.state !== "OPEN" && round.state !== "COLLECTING") throw new RoundError(`Round is ${round.state}, it no longer accepts intents.`);
  if (!(await membership(round.circleId, owner))) throw new RoundError("Join this circle first.");
  const target = await getTarget(owner);
  if (!target) throw new RoundError("Set a target portfolio before joining a round.");
  const portfolio = await loadPortfolio(owner);
  if (!portfolio.ok) throw new RoundError(`Could not read your wallet: ${portfolio.detail}`);
  if (portfolio.holdings.length === 0) throw new RoundError("This wallet holds no bStocks or USDT yet, so there is nothing to rebalance.");
  const circle = await getCircle(round.circleId);
  const reg = deps().registry();

  // Circle assets are valued at the round's snapshot; anything else the wallet holds at display prices.
  const ctx = await resolveContext(portfolio, priceMap(round.snapshot));
  const policy = { ...policyFor(target, ctx.nowSec, circle.durationSec), validUntil: round.freezesAt + APPROVAL_WINDOW_SEC };
  const resolved = resolveGoal(specFromTarget(target, portfolio.holdings.map((h) => h.asset.symbol)), ctx, policy);
  if (!resolved.ok) throw new RoundError(resolved.problems.map((p) => p.detail).join(" "));
  const preview = resolved.preview;
  const tradable = roundUniverse(round, circle);
  const limits = preview.limits.filter((l) => tradable.has(l.assetUid));
  const symbolOf = (uid: string) => (reg.has(uid) ? reg.getByUid(uid).symbol : uid);
  const outsideCircle = preview.limits.filter((l) => !tradable.has(l.assetUid)).map((l) => symbolOf(l.assetUid));
  if (limits.length === 0) throw new RoundError(`Your target does not change any asset this round can trade (${[...tradable.keys()].map(symbolOf).join(", ")}).`);
  if (!limits.some((l) => l.maxOutRaw > 0n) || !limits.some((l) => l.maxInRaw > 0n)) {
    throw new RoundError("Within this circle's assets your target only buys or only sells, so there is nothing to swap here. Add the asset you would sell or buy to the circle, or adjust your target.");
  }

  const intent = intentFromPreview({ ...preview, limits }, {
    circleId: round.circleId,
    roundId: round.id,
    valuationSnapshotHash: round.snapshotHash,
    agent: owner,
    nonce: BigInt(ctx.nowSec),
    validAfter: round.opensAt - 60,
    validUntil: round.freezesAt + APPROVAL_WINDOW_SEC,
  });
  const rows = limits.map((l) => {
    const sell = l.maxOutRaw > 0n;
    const raw = sell ? l.maxOutRaw : l.maxInRaw;
    return { symbol: symbolOf(l.assetUid), side: sell ? ("SELL" as const) : ("BUY" as const), amountTokens: tokensOf(raw), valueUsd: usd((raw * (ctx.prices.get(l.assetUid) ?? 0n)) / 10n ** 18n) };
  });
  return { intent, rows, outsideCircle, warnings: preview.warnings };
}

export function intentSigningPayload(intent: PortfolioIntent, round: Pick<RoundRecord, "settlementContract" | "chainId">) {
  return intentTypedData(intent, round.settlementContract, round.chainId);
}

/** Accepts a signed intent. The signature is checked against the round's settlement domain before anything is stored. */
export async function submitIntent(roundId: string, owner: Address, intent: PortfolioIntent, signature: Hex): Promise<"ACCEPTED" | "REPLACED" | "UNCHANGED"> {
  const round = await getRound(roundId);
  const circle = await getCircle(round.circleId);
  if (round.state !== "OPEN" && round.state !== "COLLECTING") throw new RoundError(`Round is ${round.state}, it no longer accepts intents.`);
  if (now() >= round.freezesAt) throw new RoundError("The collection window has closed.");
  if (!(await membership(circle.id, owner))) throw new RoundError("Only circle members can sign into this round.");
  if (!intent || typeof intent !== "object" || !Array.isArray(intent.assets)) throw new RoundError("Send the intent exactly as GET /intent returned it.");
  if (getAddress(intent.owner) !== getAddress(owner)) throw new RoundError("The intent owner must be the signed-in wallet.");
  if (intent.roundId !== round.id || intent.circleId !== round.circleId) throw new RoundError("This intent is bound to a different round.");
  if (intent.valuationSnapshotHash !== round.snapshotHash) throw new RoundError("This intent was priced against a different snapshot.");
  const tradable = roundUniverse(round, circle);
  for (const l of intent.assets) if (!tradable.has(l.assetUid)) throw new RoundError(`${l.assetUid} is not tradable in this round.`);
  const signer = await verifyIntentSignature(intent, signature, round.settlementContract, round.chainId).catch((error: unknown) => {
    throw new RoundError(`The intent signature is not valid: ${(error as Error).message.split("\n")[0]}`);
  });
  if (getAddress(signer) !== getAddress(owner)) throw new RoundError("The signature does not belong to this wallet.");

  await ensureUser(owner);
  const d = await db();
  const intentHash = keccak256(stringToHex(toJson(intent)));
  const existing = await d.query<{ intent_hash: string }>("select intent_hash from intents where round_id = $1 and owner = $2", [round.id, key(owner)]);
  if (existing[0]?.intent_hash === intentHash) return "UNCHANGED";
  await d.query(
    `insert into intents (round_id, owner, intent, signature, intent_hash) values ($1, $2, $3::text::jsonb, $4, $5)
     on conflict (round_id, owner) do update set intent = excluded.intent, signature = excluded.signature, intent_hash = excluded.intent_hash, submitted_at = now()`,
    [round.id, key(owner), toJson(intent), signature, intentHash],
  );
  await d.query("update residual_decisions set consumed_round_id = $1 where owner = $2 and user_choice = 'CARRY_FORWARD' and consumed_round_id is null and round_id in (select id from rounds where circle_id = $3)", [round.id, key(owner), round.circleId]);
  if (round.state === "OPEN") await transition(round, "COLLECTING", "first intent signed");
  await logActivity(owner, "INTENT_SIGNED", { circle: circle.name, sequence: round.sequence }, { roundId: round.id, circleId: round.circleId });
  return existing.length ? "REPLACED" : "ACCEPTED";
}

export async function approvalsFor(roundId: string): Promise<Map<Address, { nonce: bigint; signature: Hex }>> {
  const rows = await (await db()).query<{ participant: string; nonce: string; signature: string }>("select * from approvals where round_id = $1", [roundId]);
  return new Map(rows.map((r) => [getAddress(r.participant), { nonce: BigInt(r.nonce), signature: r.signature as Hex }]));
}

export function approvalPayload(plan: SettlementPlan, participant: Address) {
  const nonce = approvalNonce(plan.planHash, participant);
  return { nonce, typedData: approvalTypedData(plan, participant, nonce) };
}

/** Records one participant's EIP-712 approval of the exact plan. The last approval makes the round ready to settle. */
export async function submitApproval(roundId: string, participant: Address, signature: Hex): Promise<RoundRecord> {
  let round = await advance(await getRound(roundId));
  if (!round.plan) throw new RoundError("This round has no plan to approve.");
  if (round.state !== "PROPOSED" && round.state !== "APPROVING") throw new RoundError(`Round is ${round.state}, approvals are closed.`);
  const plan = round.plan;
  if (!plan.contractPlan.participants.some((p) => getAddress(p) === getAddress(participant))) throw new RoundError("Your wallet is not part of this plan.");
  const { nonce, typedData } = approvalPayload(plan, participant);
  const valid = await deps().client().verifyTypedData({ address: participant, signature, ...typedData });
  if (!valid) throw new RoundError("That signature does not approve this exact plan.");
  const inserted = await (await db()).query("insert into approvals (round_id, participant, nonce, signature) values ($1, $2, $3, $4) on conflict (round_id, participant) do nothing returning participant", [round.id, key(participant), nonce.toString(), signature]);
  if (inserted.length > 0) await logActivity(participant, "PLAN_APPROVED", { planHash: plan.planHash }, { roundId: round.id, circleId: round.circleId });
  if (round.state === "PROPOSED") round = await transition(round, "APPROVING", "first approval");
  const approvals = await approvalsFor(round.id);
  if (plan.contractPlan.participants.every((p) => approvals.has(getAddress(p)))) round = await transition(round, "READY_TO_SETTLE", "every participant approved");
  return round;
}

/** What the viewer must still do on-chain before settle(): allowances for their own outflows, read live. */
export async function allowanceStatus(round: RoundRecord, owner: Address) {
  if (!round.plan) return [];
  const needs = [...requiredOutflows(round.plan)].filter(([k]) => k.startsWith(owner.toLowerCase()));
  const rpc = deps().client();
  return Promise.all(
    needs.map(async ([k, amount]) => {
      const token = getAddress(k.split("|")[1] as string);
      const [allowance, balance] = await Promise.all([
        rpc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, round.settlementContract] }),
        rpc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      ]);
      return { token, amount, allowance, balance, sufficient: allowance >= amount, funded: balance >= amount };
    }),
  );
}

/**
 * The settle() call any participant can send once every approval is in. Before handing it out, the whole call is
 * simulated: a missing allowance, a moved balance or an issuer-side transfer block shows up here, not as a revert.
 */
export async function settleCall(round: RoundRecord): Promise<{ to: Address; data: Hex }> {
  if (round.state !== "READY_TO_SETTLE" || !round.plan) throw new RoundError(`Round is ${round.state}, not ready to settle.`);
  const approvals = await approvalsFor(round.id);
  const ordered = round.plan.contractPlan.participants.map((p) => approvals.get(getAddress(p)) as { nonce: bigint; signature: Hex });
  const report = await preflightSettlement(deps().client(), round.plan, new Map([...approvals].map(([a, v]) => [a, v.nonce])), now(), { approvals: ordered });
  if (!report.ok) throw new RoundError(`Settlement would fail right now: ${report.issues.map((i) => i.detail).join("; ")}`);
  return { to: round.settlementContract, data: encodeFunctionData({ abi: samaSettlementAbi, functionName: "settle", args: [round.plan.contractPlan, ordered] }) };
}

/**
 * Records a settlement transaction a participant sent, then verifies it from chain data alone on an independent RPC.
 * The receipt, calldata, logs and balance deltas decide the round's final state, not the caller.
 */
export async function recordSettlement(roundId: string, reporter: Address, txHash: Hex): Promise<RoundRecord> {
  let round = await getRound(roundId);
  if (!round.plan) throw new RoundError("This round has no plan to settle.");
  if (!round.plan.contractPlan.participants.some((p) => getAddress(p) === getAddress(reporter))) throw new RoundError("Only participants in the plan can report its settlement.");
  if (round.state === "READY_TO_SETTLE") {
    await assertSettlesPlan(round, txHash);
    round = await transition(round, "SETTLING", "settlement tx sent by a participant", { settlement_tx: txHash });
    log("settlement.reported", { round: round.id, tx: txHash, reporter });
  }
  return completeSettlement(round);
}

async function completeSettlement(start: RoundRecord): Promise<RoundRecord> {
  let round = start;
  if (!round.settlementTx || !round.plan) return round;
  const tx = round.settlementTx;
  if (round.state === "SETTLING") {
    const receipt = await deps().client().getTransactionReceipt({ hash: tx }).catch(() => null);
    if (!receipt) return round;
    if (receipt.status !== "success") return transition(round, "SETTLEMENT_REVERTED", `tx ${tx} reverted`);
    round = await transition(round, "SETTLED", `block ${receipt.blockNumber}`);
    if (round.state !== "SETTLED") return round;
  }
  if (round.state === "SETTLED") round = await transition(round, "VERIFYING");
  if (round.state !== "VERIFYING") return round;
  const approvals = await approvalsFor(round.id);
  const plan = round.plan as SettlementPlan;
  const input = {
    txHash: tx,
    settlementContract: round.settlementContract,
    plan: plan.contractPlan,
    nonces: new Map([...approvals].map(([a, v]) => [a, v.nonce])),
    watchTokens: [...new Set(plan.contractPlan.legs.map((l) => l.token))],
  };
  // The independent verifier RPC may lack historical state. Then the check reruns on the executor RPC and the record
  // says so; independence is never claimed for that run.
  let verifierRpc: { client: PublicClient; providers: Providers } = deps().verifierClient();
  let verification: SettlementVerification;
  try {
    verification = await verifySettlement(verifierRpc.client, input);
  } catch (error) {
    const reason = (error as Error).message.split("\n")[0] ?? "verifier RPC error";
    log("settlement.verifier_fallback", { round: round.id, tx, verifier: verifierRpc.providers.verifier, reason }, "warn");
    verifierRpc = { client: deps().client(), providers: { executor: verifierRpc.providers.executor, verifier: verifierRpc.providers.executor, independent: false, fallbackReason: `independent RPC ${verifierRpc.providers.verifier} failed: ${reason}` } };
    verification = await verifySettlement(verifierRpc.client, input);
  }
  // The set of wallets whose approval nonce the contract consumed must be exactly the plan's participants.
  const consumed = new Set(verification.checks.filter((c) => c.name.startsWith("event.NonceConsumed.") && c.status === "PASS").map((c) => c.name.slice("event.NonceConsumed.".length).toLowerCase()));
  const expected = plan.contractPlan.participants.map((p) => p.toLowerCase());
  const participantsMatch = consumed.size === expected.length && expected.every((p) => consumed.has(p));
  verification.checks.push({ name: "participants.set", status: participantsMatch ? "PASS" : "FAIL", detail: `${consumed.size} approvals consumed on-chain for ${expected.length} plan participants` });
  if (!participantsMatch) verification.status = "FAIL";

  // Round-level checks the contract-level verifier cannot see. The two independence checks are honest labels, not
  // gates: a non-independent source is INCONCLUSIVE, which the receipt shows, and never fails a settled round.
  const [sent, block] = await Promise.all([
    verifierRpc.client.getTransaction({ hash: tx }).catch(() => null),
    verification.blockNumber !== undefined ? verifierRpc.client.getBlock({ blockNumber: verification.blockNumber }).catch(() => null) : Promise.resolve(null),
  ]);
  const chainOk = sent !== null && (sent.chainId === undefined || sent.chainId === round.chainId);
  verification.checks.push({ name: "chain.id", status: chainOk ? "PASS" : "FAIL", detail: `transaction chain ${sent?.chainId ?? "unknown"}, round chain ${round.chainId}` });
  const ts = block ? block.timestamp : null;
  const inWindow = ts !== null && ts >= plan.contractPlan.validAfter && ts <= plan.contractPlan.validUntil;
  verification.checks.push({ name: "plan.window", status: ts === null ? "INCONCLUSIVE" : inWindow ? "PASS" : "FAIL", detail: `settled at ${ts ?? "?"}, plan valid ${plan.contractPlan.validAfter}..${plan.contractPlan.validUntil}` });
  const snapshotOk = plan.contractPlan.valuationSnapshotHash === round.snapshotHash;
  verification.checks.push({ name: "plan.snapshotHash", status: snapshotOk ? "PASS" : "FAIL", detail: `plan snapshot ${plan.contractPlan.valuationSnapshotHash}, round snapshot ${round.snapshotHash}` });
  const unchecked = round.snapshot.prices.filter((p) => p.source === "BINANCE_WEB3_RWA" && p.check?.twapUsdE18 === undefined).length;
  verification.checks.push({ name: "prices.independent", status: round.snapshotMeta.independent ? "PASS" : "INCONCLUSIVE", detail: round.snapshotMeta.independent ? "every stock price was cross-checked against a PancakeSwap 30-minute average" : `${unchecked} stock price(s) came from Binance only, with no on-chain cross-check` });
  verification.checks.push({ name: "providers.independent", status: verifierRpc.providers.independent ? "PASS" : "INCONCLUSIVE", detail: verifierRpc.providers.independent ? `verified through ${verifierRpc.providers.verifier}, executed through ${verifierRpc.providers.executor}` : (verifierRpc.providers.fallbackReason ?? `verifier and executor share ${verifierRpc.providers.executor}`) });
  if (!chainOk || (ts !== null && !inWindow) || !snapshotOk) verification.status = "FAIL";
  const final = verification.status === "PASS" ? "COMPLETE" : "VERIFICATION_FAILED";
  log("settlement.verified", { round: round.id, tx, status: verification.status, failed: verification.checks.filter((c) => c.status !== "PASS").map((c) => c.name), ...verifierRpc.providers });
  const done = await transition(round, final, `verifier ${verification.status}`, { verification: toJson({ ...verification, providers: verifierRpc.providers }) });
  if (done.moved) for (const p of plan.contractPlan.participants) await logActivity(p, "SETTLED", { txHash: tx, verifier: verification.status }, { roundId: round.id, circleId: round.circleId });
  return done;
}

/**
 * A reported hash must be a call to this round's settlement contract on this chain whose settle() argument is exactly
 * this round's plan. Otherwise any member could post an unrelated successful transaction and fail the verification.
 */
async function assertSettlesPlan(round: RoundRecord, txHash: Hex) {
  const plan = round.plan as SettlementPlan;
  const tx = await deps().client().getTransaction({ hash: txHash }).catch(() => undefined);
  if (!tx) throw new RoundError("That transaction was not found on BNB Chain.");
  if (tx.chainId !== undefined && tx.chainId !== round.chainId) throw new RoundError(`That transaction is on chain ${tx.chainId}, not ${round.chainId}.`);
  if (!tx.to || getAddress(tx.to) !== getAddress(round.settlementContract)) throw new RoundError("That transaction is not a call to this round's settlement contract.");
  const call = decodeFunctionData({ abi: samaSettlementAbi, data: tx.input });
  if (call.functionName !== "settle" || hashContractPlan((call.args as readonly [ContractPlan, unknown])[0]) !== plan.planHash) throw new RoundError("That transaction settles a different plan.");
}

export function ownFills(round: RoundRecord, owner: Address) {
  return (round.match?.fills ?? []).filter((f) => getAddress(f.owner) === getAddress(owner));
}
