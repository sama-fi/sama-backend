import { getAddress, type Address } from "viem";
import type { Activity, ResidualStyle, Settings } from "@sama/api-types";
import { listedToken } from "@sama/tokens";
import { db, fromJson, toJson } from "./db/client.ts";
import { InputError } from "./errors.ts";
import { deps } from "./deps.ts";

/** Addresses are stored lowercase so lookups never depend on checksum casing. */
export const key = (address: string) => address.toLowerCase();

export type User = { address: Address; privyUserId: string | null; walletKind: string | null; email: string | null; onboardingDone: boolean; createdAt: string };

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
  onboarding_done: boolean;
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
  return { address: getAddress(r.address), privyUserId: r.privy_user_id, walletKind: r.wallet_kind, email: r.email, onboardingDone: r.onboarding_done, createdAt: new Date(r.created_at).toISOString() };
}

export async function onboardingDone(address: Address): Promise<boolean> {
  const [row] = await (await db()).query<{ onboarding_done: boolean }>("select onboarding_done from users where address = $1", [key(address)]);
  return row?.onboarding_done ?? false;
}

export async function saveOnboardingDone(address: Address, done: boolean) {
  await ensureUser(address);
  await (await db()).query("update users set onboarding_done = $2, last_seen_at = now() where address = $1", [key(address), done]);
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

/** Filter groups for the Activity page. Must match the frontend's `activityGroup` (sama-frontend/lib/activity.ts). */
export type ActivityGroup = "rounds" | "circles" | "targets" | "leftovers" | "transfers";

const GROUP_KINDS: Record<ActivityGroup, ActivityKind[]> = {
  rounds: ["INTENT_SIGNED", "ROUND_MATCHED", "ROUND_NO_CROSS", "PLAN_APPROVED", "SETTLED"],
  circles: ["CIRCLE_CREATED", "CIRCLE_JOINED"],
  targets: ["TARGET_SAVED"],
  leftovers: ["RESIDUAL_DECIDED"],
  transfers: ["TRANSFER_IN", "TRANSFER_OUT"],
};

export type ActivityQuery = { limit?: number; cursor?: string | null; group?: ActivityGroup | null; sinceMs?: number | null };
export type ActivityPage = { items: Activity[]; nextCursor: string | null };

/** The cursor is the last row's time and id, so a page after it stays right when new rows arrive at the top. */
function encodeCursor(createdAt: Date, id: string | number): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^\d+$/.test(id)) throw new InputError("The page cursor is not valid.");
  return { at, id };
}

/** One page of the wallet's activity, newest first. Filters run in SQL so a page is full of matching rows. */
export async function pageActivity(address: string, q: ActivityQuery = {}): Promise<ActivityPage> {
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const kinds = q.group ? GROUP_KINDS[q.group] : null;
  const since = q.sinceMs ? new Date(q.sinceMs).toISOString() : null;
  // One extra row tells whether another page exists without a second count query.
  const rows = await (await db()).query<{ id: string | number; kind: string; round_id: string | null; detail: unknown; created_at: Date }>(
    `select id, kind, round_id, detail, created_at from activity
      where address = $1
        and ($2::text[] is null or kind = any($2::text[]))
        and ($3::timestamptz is null or created_at >= $3::timestamptz)
        and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::bigint))
      order by created_at desc, id desc
      limit $6`,
    [key(address), kinds, since, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const items: Activity[] = page.map((r) => ({ id: String(r.id), kind: r.kind, detail: fromJson<Record<string, string | number>>(r.detail), roundId: r.round_id, createdAt: new Date(r.created_at).toISOString() }));
  const last = page[page.length - 1];
  return {
    items: await Promise.all(items.map((a) => (a.kind === "TRANSFER_IN" || a.kind === "TRANSFER_OUT" ? relabelTransfer(a) : a))),
    nextCursor: rows.length > limit && last ? encodeCursor(new Date(last.created_at), last.id) : null,
  };
}

/** The newest rows only, for Home. */
export async function listActivity(address: string, limit = 30): Promise<Activity[]> {
  return (await pageActivity(address, { limit })).items;
}

/**
 * Transfer rows are named from the current registry and PancakeSwap list, not from whatever the token contract said when
 * the row was written. That keeps older rows right too: an unlisted token reads UNKNOWN, with no logo.
 */
async function relabelTransfer(a: Activity): Promise<Activity> {
  const token = String(a.detail.token ?? "").toLowerCase();
  const asset = deps().registry().all().find((x) => x.contractAddress.toLowerCase() === token);
  const listed = asset ? undefined : await listedToken(token);
  const symbol = asset?.symbol ?? listed?.symbol ?? "UNKNOWN";
  const logo = listed?.logoURI ?? "";
  return { ...a, detail: { ...a.detail, symbol, logo } };
}
