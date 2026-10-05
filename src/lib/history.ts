import type { Address } from "viem";
import type { HistoryPoint, HistoryRange } from "@sama/api-types";
import { db } from "./db/client.ts";
import { InputError } from "./errors.ts";
import type { Portfolio } from "@sama/api-types";
import { key } from "./users.ts";

const RANGE_SEC: Record<HistoryRange, number | null> = { "1H": 3_600, "1D": 86_400, "1W": 7 * 86_400, "1M": 30 * 86_400, "1Y": 365 * 86_400, ALL: null };
const RECORD_EVERY_SEC = 300;

/** Records the wallet's total at most every five minutes. Binance has no price history, so the chart is built from these. */
export async function recordSnapshot(address: Address, portfolio: Portfolio) {
  if (!portfolio.ok) return;
  const d = await db();
  const [last] = await d.query<{ at: Date }>("select at from portfolio_snapshots where address = $1 order by at desc limit 1", [key(address)]);
  if (last && Date.now() - new Date(last.at).getTime() < RECORD_EVERY_SEC * 1000) return;
  await d.query("insert into portfolio_snapshots (address, total_usd) values ($1, $2) on conflict do nothing", [key(address), portfolio.totalUsd]);
}

/** Recorded totals in the window, oldest first, ending with the live total. Sparse until the wallet has been viewed for a while. */
export async function portfolioHistory(address: Address, range: string, live: Portfolio): Promise<HistoryPoint[]> {
  if (!(range in RANGE_SEC)) throw new InputError(`Unknown range ${range}. Use one of ${Object.keys(RANGE_SEC).join(", ")}.`);
  const span = RANGE_SEC[range as HistoryRange];
  const rows = await (await db()).query<{ at: Date; total_usd: number }>(
    span === null
      ? "select at, total_usd from portfolio_snapshots where address = $1 order by at"
      : "select at, total_usd from portfolio_snapshots where address = $1 and at >= now() - ($2::int * interval '1 second') order by at",
    span === null ? [key(address)] : [key(address), span],
  );
  const points = rows.map((r) => ({ t: new Date(r.at).getTime(), usd: Number(r.total_usd) }));
  if (live.ok) points.push({ t: Date.now(), usd: live.totalUsd });
  return points;
}
