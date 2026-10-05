import type { Proof } from "@sama/api-types";
import { deployment } from "@sama/shared";
import { db } from "./db/client.ts";
import { env } from "./env.ts";
import { usd } from "./market.ts";
import { getRound } from "./rounds.ts";

/** Settled rounds, newest first, for the public /proof page. Only aggregate facts and hashes leave the server. */
export async function proofData(limit = 50): Promise<Proof> {
  const e = env();
  let dep: ReturnType<typeof deployment> | null = null;
  try {
    dep = deployment(e.chainId);
  } catch {
    dep = null;
  }
  const rows = await (await db()).query<{ id: string; name: string; visibility: string }>(
    `select r.id, c.name, c.visibility from rounds r join circles c on c.id = r.circle_id
     where r.settlement_tx is not null and r.state in ('COMPLETE', 'VERIFICATION_FAILED', 'VERIFYING', 'SETTLED')
     order by r.created_at desc limit $1`,
    [limit],
  );
  const rounds: Proof["rounds"] = [];
  for (const row of rows) {
    const r = await getRound(row.id);
    if (!r.settlementTx || !r.plan) continue;
    const settledStep = r.history.find((h) => h.to === "SETTLED");
    const v = r.verification;
    rounds.push({
      roundId: r.id,
      circleName: row.visibility === "PUBLIC" ? row.name : null,
      sequence: r.sequence,
      state: r.state,
      settledAt: new Date((settledStep?.at ?? r.freezesAt) * 1000).toISOString(),
      settlementTx: r.settlementTx,
      participants: r.plan.contractPlan.participants.length,
      legCount: r.plan.contractPlan.legs.length,
      cycleCount: r.match?.cycles.length ?? 0,
      crossedUsd: r.match ? usd(r.match.totals.crossedNotionalUsdE18) : 0,
      verification: v
        ? {
            status: v.status,
            passed: v.checks.filter((c) => c.status === "PASS").length,
            total: v.checks.length,
            providersIndependent: v.providers?.independent ?? false,
            pricesIndependent: r.snapshotMeta.independent,
          }
        : null,
    });
  }
  return {
    chainId: e.chainId,
    settlement: {
      address: e.settlementContract,
      deployTx: dep && dep.settlement.toLowerCase() === e.settlementContract.toLowerCase() ? dep.txHash : null,
      deployBlock: dep && dep.settlement.toLowerCase() === e.settlementContract.toLowerCase() ? dep.block : null,
      verifiedSource: dep?.verifiedOnBscScan ?? false,
    },
    rounds,
  };
}
