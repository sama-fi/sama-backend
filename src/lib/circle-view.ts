import type { Address } from "viem";
import type { Circle } from "@sama/api-types";
import { membership, type CircleRecord } from "./circles.ts";
import { usd } from "./market.ts";
import { roundsForCircle, TERMINAL } from "./rounds.ts";

/** A circle as the viewer sees it: their role, the live round if any, the next scheduled round and recent history. */
export async function circleView(c: CircleRecord, viewer: Address): Promise<Circle> {
  const [role, rounds] = await Promise.all([membership(c.id, viewer), roundsForCircle(c.id)]);
  const live = rounds.find((r) => !TERMINAL.has(r.state)) ?? null;
  const finished = rounds.filter((r) => TERMINAL.has(r.state));
  const lastEnd = finished[0]?.history.at(-1)?.at;
  const nextRoundAt = !live && c.cadenceSec !== null ? new Date(((lastEnd ?? Math.floor(Date.parse(c.createdAt) / 1000)) + c.cadenceSec) * 1000).toISOString() : null;
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    visibility: c.visibility,
    assetSymbols: c.assetSymbols,
    cadenceSec: c.cadenceSec,
    durationSec: c.durationSec,
    minParticipants: c.minParticipants,
    memberCount: c.memberCount,
    residualBehavior: c.residualBehavior,
    role: role ?? null,
    liveRound: live ? { id: live.id, sequence: live.sequence, state: live.state, freezesAt: live.freezesAt } : null,
    nextRoundAt,
    history: finished.slice(0, 10).map((r) => ({
      id: r.id,
      sequence: r.sequence,
      state: r.state,
      crossedUsd: r.match ? usd(r.match.totals.crossedNotionalUsdE18) : 0,
      endedAt: new Date((r.history.at(-1)?.at ?? r.freezesAt) * 1000).toISOString(),
    })),
  };
}
