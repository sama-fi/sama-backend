import { getAddress, type Address } from "viem";
import type { Circle, Home, PendingRound, RoundView } from "@sama/api-types";
import { priceMap } from "@sama/portfolio";
import { circleView } from "./circle-view.ts";
import { getCircle, membership, myCircles } from "./circles.ts";
import { deps } from "./deps.ts";
import { RoundError } from "./errors.ts";
import { loadPortfolio, toWirePortfolio, tokensOf, usd } from "./market.ts";
import { decisionsFor, recommend, residualItems, residualsReady } from "./residuals.ts";
import { advance, allowanceStatus, approvalsFor, getRound, intentsFor, prepareIntent, TERMINAL } from "./rounds.ts";
import { toWireTarget } from "./targets.ts";
import { getTarget, listActivity } from "./users.ts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** English labels for every verifier check id; the frontend translates by id and falls back to these. */
export const CHECK_LABELS: Record<string, string> = {
  "tx.status": "Receipt status is success",
  "tx.to": "Called the settlement contract",
  "chain.id": "Chain is BNB Smart Chain",
  "calldata.plan": "Calldata matches the approved plan",
  "event.PlanSettled": "PlanSettled event emitted",
  "event.CrossingLeg": "One event per transfer",
  "event.Transfer": "Only planned transfers happened",
  "event.NonceConsumed": "Approval used on-chain",
  "state.planSettled": "Plan marked settled on-chain",
  "state.nonceUsed": "Approval nonces consumed",
  "participants.set": "Every participant approved",
  "balances.netDelta": "Balances moved exactly",
  "balances.noCustody": "Contract holds nothing",
  "plan.window": "Settled within the valid window",
  "plan.snapshotHash": "Prices match the round snapshot",
  "prices.independent": "Prices cross-checked on-chain",
  "providers.independent": "Read through an independent provider",
};

export function checkId(name: string): string {
  return name.startsWith("event.NonceConsumed.") ? "event.NonceConsumed" : name;
}

/** Unsigned intent previews are rebuilt at most every 30 s per viewer: the round page polls. */
const previewCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof prepareIntent>> | { error: string } }>();
const PREVIEW_TTL_MS = 30_000;

async function cachedPreview(roundId: string, viewer: Address) {
  const k = `${roundId}|${viewer.toLowerCase()}`;
  const hit = previewCache.get(k);
  if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) return hit.value;
  const value = await prepareIntent(roundId, viewer).catch((error: unknown) => ({ error: (error as Error).message }));
  previewCache.set(k, { at: Date.now(), value });
  return value;
}

export function clearPreview(roundId: string, viewer: Address) {
  previewCache.delete(`${roundId}|${viewer.toLowerCase()}`);
}

/**
 * Everything one member may see about a round: their own intent, legs and leftover, plus aggregate totals. Other
 * members appear only as "Member 2", "Member 3".
 */
export async function roundView(roundId: string, viewer: Address): Promise<RoundView> {
  const stored = await getRound(roundId);
  const role = await membership(stored.circleId, viewer);
  if (!role) throw new RoundError("Only members of this circle can open its rounds.");
  const round = await advance(stored);
  const circle = await getCircle(round.circleId);
  const reg = deps().registry();
  const symbol = (uid: string) => (reg.has(uid) ? reg.getByUid(uid).symbol : uid);
  const prices = priceMap(round.snapshot);

  const entries = await intentsFor(round.id);
  const mine = entries.find((e) => same(e.owner, viewer));
  const labels = new Map<string, string>([[viewer.toLowerCase(), "You"]]);
  entries.filter((e) => !same(e.owner, viewer)).forEach((e, i) => labels.set(e.owner.toLowerCase(), `${i + 2}`));
  const label = (a: string) => labels.get(a.toLowerCase()) ?? "?";
  const members = new Set(entries.map((e) => e.owner.toLowerCase()));
  const pseudonymize = (text: string) => text.replace(/0x[0-9a-fA-F]{40}/g, (a) => (members.has(a.toLowerCase()) ? (same(a, viewer) ? "you" : `member ${label(a)}`) : a));

  const collecting = round.state === "OPEN" || round.state === "COLLECTING";
  let intent: RoundView["you"]["intent"] = [];
  let outsideCircle: string[] = [];
  let joinBlocker: string | null = null;
  if (mine) {
    intent = mine.intent.assets.map((l) => {
      const sell = l.maxOutRaw > 0n;
      const raw = sell ? l.maxOutRaw : l.maxInRaw;
      return { symbol: symbol(l.assetUid), side: sell ? ("SELL" as const) : ("BUY" as const), amountTokens: tokensOf(raw), valueUsd: usd((raw * (prices.get(l.assetUid) ?? 0n)) / 10n ** 18n) };
    });
  } else if (collecting) {
    const preview = await cachedPreview(round.id, viewer);
    if ("error" in preview) joinBlocker = preview.error;
    else {
      intent = preview.rows;
      outsideCircle = preview.outsideCircle;
    }
  }

  const legs = (round.plan?.legs ?? [])
    .filter((l) => same(l.from, viewer) || same(l.to, viewer))
    .map((l) => ({ direction: same(l.from, viewer) ? ("SEND" as const) : ("RECEIVE" as const), counterparty: label(same(l.from, viewer) ? l.to : l.from), symbol: symbol(l.assetUid), amountTokens: tokensOf(l.amount), valueUsd: usd((l.amount * (prices.get(l.assetUid) ?? 0n)) / 10n ** 18n) }));

  const inPlan = Boolean(round.plan?.contractPlan.participants.some((p) => same(p, viewer)));
  const approvals = await approvalsFor(round.id);
  const needsAllowance = inPlan && (round.state === "PROPOSED" || round.state === "APPROVING" || round.state === "READY_TO_SETTLE");
  const allowances = needsAllowance ? await allowanceStatus(round, viewer) : [];
  const ready = residualsReady(round);
  const residual = mine && ready ? residualItems(round, viewer) : [];
  const decisions = mine ? await decisionsFor(round.id, viewer) : [];
  const rec = mine && ready && residual.some((r) => !r.dust) && decisions.length === 0 ? await recommend(round, viewer).catch((error: unknown) => ({ pair: null, plan: null, quote: null, unavailable: `Could not price the leftover right now: ${(error as Error).message.split("\n")[0]}` })) : null;
  const decided = decisions[0];
  const totals = round.match?.totals;
  const excluded = new Set(round.snapshotMeta.excluded.map((e) => e.assetUid as string));

  return {
    round: {
      id: round.id,
      sequence: round.sequence,
      state: round.state,
      terminal: TERMINAL.has(round.state),
      freezesAt: round.freezesAt,
      snapshotHash: round.snapshotHash,
      prices: round.snapshot.prices.map((p) => ({
        symbol: symbol(p.assetUid),
        priceUsd: usd(p.priceUsdE18),
        source: p.source === "FIXED_CASH" ? ("FIXED" as const) : p.check?.twapUsdE18 !== undefined ? ("BINANCE+TWAP" as const) : ("BINANCE" as const),
        ...(p.multiplierE18 !== undefined ? { uiMultiplier: Number(p.multiplierE18) / 1e18 } : {}),
      })),
      excludedAssets: round.snapshotMeta.excluded.filter((e) => excluded.has(e.assetUid)).map((e) => ({ symbol: e.symbol, reason: e.reason })),
      marketSession: round.snapshotMeta.session as NonNullable<RoundView["round"]["marketSession"]>,
      settlementContract: round.settlementContract,
      settlementTx: round.settlementTx,
      planHash: round.plan?.planHash ?? null,
      planValidUntil: round.plan ? Number(round.plan.contractPlan.validUntil) : null,
      history: round.history.map((h) => ({ state: h.to, at: new Date(h.at * 1000).toISOString(), reason: h.reason ? pseudonymize(h.reason) : null })),
      verification: round.verification
        ? {
            status: round.verification.status,
            blockNumber: round.verification.blockNumber?.toString() ?? null,
            checks: round.verification.checks.map((c) => {
              const id = checkId(c.name);
              const who = id === "event.NonceConsumed" ? pseudonymize(c.name.slice("event.NonceConsumed.".length)) : null;
              return { id, name: `${CHECK_LABELS[id] ?? c.name}${who ? ` (${who})` : ""}`, status: c.status, detail: pseudonymize(c.detail) };
            }),
            providers: round.verification.providers ? { executor: round.verification.providers.executor, verifier: round.verification.providers.verifier, independent: round.verification.providers.independent } : null,
          }
        : null,
    },
    circle: { id: circle.id, name: circle.name, assetSymbols: circle.assetSymbols, minParticipants: circle.minParticipants, memberCount: circle.memberCount, residualBehavior: circle.residualBehavior, isOrganizer: role === "ORGANIZER" },
    you: {
      signed: Boolean(mine),
      intent,
      outsideCircle,
      legs,
      inPlan,
      approved: approvals.has(getAddress(viewer)),
      allowances: allowances.map((a) => ({ token: a.token, symbol: reg.requireCanonicalAddress(a.token).symbol, amountRaw: a.amount, amountTokens: tokensOf(a.amount), sufficient: a.sufficient, funded: a.funded })),
      residual: residual.map((r) => ({ symbol: r.symbol, side: r.side, amountTokens: tokensOf(r.amountRaw), valueUsd: r.valueUsd, dust: r.dust })),
      recommendation: rec
        ? {
            decision: rec.plan?.decision ?? null,
            reasons: rec.plan?.reasons ?? (rec.unavailable ? [rec.unavailable] : []),
            canExecute: Boolean(rec.pair && rec.quote && rec.plan?.decision === "EXECUTE_NOW"),
            costPct: rec.plan?.route ? rec.plan.route.allInCostBps / 100 : rec.plan?.evaluated[0] ? rec.plan.evaluated[0].allInCostBps / 100 : null,
          }
        : null,
      decision: decided ? { choice: decided.userChoice, txHash: typeof decided.detail.txHash === "string" ? decided.detail.txHash : null } : null,
      joinBlocker,
    },
    aggregate: {
      signed: entries.length,
      participants: round.plan?.contractPlan.participants.length ?? 0,
      approvals: approvals.size,
      requestedUsd: totals ? usd(totals.requestedNotionalUsdE18) : 0,
      crossedUsd: totals ? usd(totals.crossedNotionalUsdE18) : 0,
      residualUsd: totals ? usd(totals.residualNotionalUsdE18) : 0,
      crossRateBps: totals ? Number(totals.crossRateBps) : 0,
      legCount: round.plan?.legs.length ?? 0,
      cycleCount: round.match?.cycles.length ?? 0,
    },
    // Gas sponsorship is outside V1.
    gasSponsored: false,
  };
}

/** The signed-in user's home: portfolio, drift from target, their circles and the rounds waiting on them. */
export async function homeView(address: Address): Promise<Home> {
  const [portfolio, target, circles, activity] = await Promise.all([loadPortfolio(address), getTarget(address), myCircles(address), listActivity(address, 5)]);
  const wirePortfolio = toWirePortfolio(portfolio);
  const drift: Home["drift"] = [];
  if (wirePortfolio.ok && target) {
    const symbols = new Set([...wirePortfolio.positions.map((x) => x.symbol), ...target.weights.map((w) => w.symbol)]);
    for (const symbol of symbols) drift.push({ symbol, currentPct: wirePortfolio.positions.find((x) => x.symbol === symbol)?.pct ?? 0, targetPct: (target.weights.find((w) => w.symbol === symbol)?.weightBps ?? 0) / 100 });
    drift.sort((a, b) => b.targetPct - a.targetPct);
  }
  const wireCircles: Circle[] = await Promise.all(circles.map((c) => circleView(c, address)));
  // Live rounds, plus the latest finished round while the viewer still has an undecided leftover in it: the next-step
  // card on Home needs both ("approve", "settle", and "decide your leftovers" after the round is over).
  const pending: PendingRound[] = [];
  for (const c of wireCircles) {
    const latestFinished = c.history[0];
    const id = c.liveRound?.id ?? (latestFinished && (latestFinished.state === "COMPLETE" || latestFinished.state === "NO_CROSS") ? latestFinished.id : null);
    if (!id) continue;
    const v = await roundView(id, address).catch(() => null);
    if (!v) continue;
    const undecided = v.you.decision ? 0 : v.you.residual.filter((r) => !r.dust).reduce((s, r) => s + r.valueUsd, 0);
    if (!c.liveRound && undecided === 0) continue;
    pending.push({ roundId: v.round.id, sequence: v.round.sequence, circleName: c.name, state: v.round.state, freezesAt: v.round.freezesAt, signed: v.you.signed, approved: v.you.approved, inPlan: v.you.inPlan, residualUndecidedUsd: undecided });
  }
  return {
    portfolio: wirePortfolio,
    target: target ? toWireTarget(target) : null,
    drift,
    totalDriftPct: drift.reduce((s, d) => s + Math.abs(d.currentPct - d.targetPct), 0) / 2,
    circles: wireCircles,
    activity,
    pending,
  };
}

export { TERMINAL };
