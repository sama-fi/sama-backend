import { getAddress, type Address } from "viem";
import type { Activity, ResidualStyle, Settings } from "@sama/api-types";
import { db, fromJson, toJson } from "./db/client.ts";

/** Addresses are stored lowercase so lookups never depend on checksum casing. */
export const key = (address: string) => address.toLowerCase();

export type User = { address: Address; privyUserId: string | null; walletKind: string | null; email: string | null; createdAt: string };

type UserRow = {
  address: string;
  privy_user_id: string | null;
  wallet_kind: string | null;
  email: string | null;
  created_at: Date;
  residual_style: string;
  cost_cap_bps: number;
  notify_email: boolean;
  notify_telegram: boolean;
  notify_in_app: boolean;
};

export async function upsertUser(input: { address: Address; privyUserId?: string | null; walletKind?: string; email?: string | null }): Promise<User> {
  const [row] = await (await db()).query<UserRow>(
    `insert into users (address, privy_user_id, wallet_kind, email) values ($1, $2, $3, $4)
     on conflict (address) do update set last_seen_at = now(),
       privy_user_id = coalesce(excluded.privy_user_id, users.privy_user_id),
       wallet_kind = coalesce(excluded.wallet_kind, users.wallet_kind),
       email = coalesce(excluded.email, users.email)
     returning *`,
    [key(input.address), input.privyUserId ?? null, input.walletKind ?? null, input.email ?? null],
  );
  const r = row as UserRow;
  return { address: getAddress(r.address), privyUserId: r.privy_user_id, walletKind: r.wallet_kind, email: r.email, createdAt: new Date(r.created_at).toISOString() };
}

/** Users referenced by memberships or intents always exist; this makes that true for wallets added by organizers. */
export async function ensureUser(address: Address) {
  await (await db()).query("insert into users (address) values ($1) on conflict do nothing", [key(address)]);
}

const RESIDUAL_STYLES: ResidualStyle[] = ["ECONOMIC", "CARRY_FORWARD", "CANCEL"];

export async function getSettings(address: Address): Promise<Settings> {
  const [r] = await (await db()).query<UserRow>("select * from users where address = $1", [key(address)]);
  return {
    notify: { email: r?.notify_email ?? true, telegram: r?.notify_telegram ?? false, inApp: r?.notify_in_app ?? true },
    residualStyle: (r?.residual_style as ResidualStyle) ?? "ECONOMIC",
    costCapBps: r?.cost_cap_bps ?? 100,
    // Gas sponsorship (MegaFuel) is outside V1: every user pays their own BNB gas.
    gasSponsorship: false,
  };
}

export function settingsProblems(s: Settings): string[] {
  const problems: string[] = [];
  if (!RESIDUAL_STYLES.includes(s.residualStyle)) problems.push(`Unknown residual style ${String(s.residualStyle)}.`);
  if (!Number.isInteger(s.costCapBps) || s.costCapBps < 0 || s.costCapBps > 2_000) problems.push("The cost cap must be a whole number of basis points between 0 and 2000.");
  if (typeof s.notify?.email !== "boolean" || typeof s.notify?.telegram !== "boolean" || typeof s.notify?.inApp !== "boolean") problems.push("Notification settings must be true or false.");
  return problems;
}

export async function saveSettings(address: Address, s: Settings) {
  await ensureUser(address);
  await (await db()).query(
    "update users set residual_style = $2, cost_cap_bps = $3, notify_email = $4, notify_telegram = $5, notify_in_app = $6 where address = $1",
    [key(address), s.residualStyle, s.costCapBps, s.notify.email, s.notify.telegram, s.notify.inApp],
  );
}

/** A saved target: whole-percent weights per allowlisted symbol (USDT included), summing to exactly 100. */
export type SavedTarget = { weights: Array<{ uid: string; symbol: string; weightBps: number }>; costCapBps: number; residualStyle: ResidualStyle; updatedAt: string };

export async function getTarget(address: string): Promise<SavedTarget | undefined> {
  const [row] = await (await db()).query<{ weights: unknown; updated_at: Date }>("select weights, updated_at from targets where address = $1", [key(address)]);
  if (!row) return undefined;
  return { ...fromJson<Omit<SavedTarget, "updatedAt">>(row.weights), updatedAt: new Date(row.updated_at).toISOString() };
}

export async function saveTarget(address: Address, target: Omit<SavedTarget, "updatedAt">, source: "STRUCTURED" | "NATURAL_LANGUAGE" = "STRUCTURED", instruction: string | null = null) {
  await ensureUser(address);
  await (await db()).query(
    `insert into targets (address, weights, source, instruction) values ($1, $2::text::jsonb, $3, $4)
     on conflict (address) do update set weights = excluded.weights, source = excluded.source, instruction = excluded.instruction, updated_at = now()`,
    [key(address), toJson(target), source, instruction],
  );
  await logActivity(address, "TARGET_SAVED", { weights: target.weights.map((w) => `${w.symbol} ${w.weightBps / 100}%`).join(", ") });
}

/** Must match the frontend's activity templates (sama-frontend/lib/i18n, `activity.kinds`) and their {placeholders}. */
export type ActivityKind = "TARGET_SAVED" | "CIRCLE_CREATED" | "CIRCLE_JOINED" | "INTENT_SIGNED" | "ROUND_MATCHED" | "ROUND_NO_CROSS" | "PLAN_APPROVED" | "SETTLED" | "RESIDUAL_DECIDED" | "TRANSFER_IN" | "TRANSFER_OUT";

export async function logActivity(address: string, kind: ActivityKind, detail: Record<string, string | number>, refs: { roundId?: string; circleId?: string } = {}) {
  await (await db()).query("insert into activity (address, kind, round_id, circle_id, detail) values ($1, $2, $3, $4, $5::text::jsonb)", [key(address), kind, refs.roundId ?? null, refs.circleId ?? null, toJson(detail)]);
}

export async function listActivity(address: string, limit = 100): Promise<Activity[]> {
  const rows = await (await db()).query<{ id: string | number; kind: string; round_id: string | null; detail: unknown; created_at: Date }>(
    "select id, kind, round_id, detail, created_at from activity where address = $1 order by created_at desc, id desc limit $2",
    [key(address), limit],
  );
  return rows.map((r) => ({ id: String(r.id), kind: r.kind, detail: fromJson<Record<string, string | number>>(r.detail), roundId: r.round_id, createdAt: new Date(r.created_at).toISOString() }));
}
