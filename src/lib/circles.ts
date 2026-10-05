import { createHash, randomBytes } from "node:crypto";
import { getAddress, keccak256, stringToHex, type Address } from "viem";
import type { NewCircle, ResidualStyle, Visibility } from "@sama/api-types";
import { db, fromJson } from "./db/client.ts";
import { deps } from "./deps.ts";
import { CircleError, NotFoundError } from "./errors.ts";
import { ensureUser, key, logActivity } from "./users.ts";

export type CircleRecord = {
  id: string;
  name: string;
  description: string;
  visibility: Visibility;
  organizer: Address;
  assetUids: string[];
  assetSymbols: string[];
  minParticipants: number;
  cadenceSec: number | null;
  durationSec: number;
  residualBehavior: ResidualStyle;
  privacyMode: "DELTAS_ONLY" | "AGGREGATE_ONLY";
  createdAt: string;
  memberCount: number;
};

type CircleRow = { id: string; name: string; description: string; visibility: string; organizer: string; asset_uids: unknown; min_participants: number; cadence_sec: number | null; duration_sec: number; residual_behavior: string; privacy_mode: string; created_at: Date; member_count: string | number };

const SELECT = "select c.*, (select count(*) from memberships m where m.circle_id = c.id) as member_count from circles c";

export const inviteHash = (code: string) => createHash("sha256").update(code).digest("hex");

function toCircle(r: CircleRow): CircleRecord {
  const reg = deps().registry();
  const uids = fromJson<string[]>(r.asset_uids);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: r.visibility as Visibility,
    organizer: getAddress(r.organizer),
    assetUids: uids,
    assetSymbols: uids.map((u) => (reg.has(u) ? reg.getByUid(u).symbol : u.slice(0, 8))),
    minParticipants: r.min_participants,
    cadenceSec: r.cadence_sec,
    durationSec: r.duration_sec,
    residualBehavior: r.residual_behavior as ResidualStyle,
    privacyMode: r.privacy_mode as CircleRecord["privacyMode"],
    createdAt: new Date(r.created_at).toISOString(),
    memberCount: Number(r.member_count),
  };
}

const VISIBILITIES: Visibility[] = ["PUBLIC", "INVITE_ONLY", "PRIVATE"];
const RESIDUALS: ResidualStyle[] = ["ECONOMIC", "CARRY_FORWARD", "CANCEL"];

export async function createCircle(organizer: Address, input: NewCircle): Promise<CircleRecord> {
  const name = String(input?.name ?? "").trim();
  if (name.length < 3 || name.length > 60) throw new CircleError("Give the circle a name between 3 and 60 characters.");
  const description = String(input.description ?? "").trim();
  if (description.length > 400) throw new CircleError("Keep the description under 400 characters.");
  if (!VISIBILITIES.includes(input.visibility)) throw new CircleError("Choose public, invite-only or private.");
  if (!RESIDUALS.includes(input.residualBehavior)) throw new CircleError("Choose what happens to leftovers.");
  const reg = deps().registry();
  const symbols = [...new Set((input.assetSymbols ?? []).map((s) => String(s).trim().toUpperCase()))];
  if (symbols.length < 2) throw new CircleError("Pick at least two assets, or nothing can cross.");
  if (symbols.length > 40) throw new CircleError("Pick at most 40 assets per circle.");
  const uids: string[] = [];
  for (const s of symbols) {
    const asset = reg.findSymbol(s);
    if (!asset) throw new CircleError(`${s} is not an asset Sama trades.`);
    uids.push(asset.uid);
  }
  if (!Number.isInteger(input.minParticipants) || input.minParticipants < 2 || input.minParticipants > 50) throw new CircleError("Minimum participants must be between 2 and 50.");
  if (!Number.isInteger(input.durationSec) || input.durationSec < 120 || input.durationSec > 86_400) throw new CircleError("Round duration must be between 2 minutes and 24 hours.");
  if (input.cadenceSec !== null && (!Number.isInteger(input.cadenceSec) || input.cadenceSec < input.durationSec)) throw new CircleError("Cadence must be at least the round duration.");

  const id = keccak256(stringToHex(`sama:circle:${organizer}:${name}:${Date.now()}:${randomBytes(8).toString("hex")}`));
  await ensureUser(organizer);
  await (await db()).tx(async (t) => {
    await t.query(
      `insert into circles (id, name, description, visibility, organizer, asset_uids, min_participants, cadence_sec, duration_sec, residual_behavior, privacy_mode)
       values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, $10, 'DELTAS_ONLY')`,
      [id, name, description, input.visibility, key(organizer), JSON.stringify(uids), input.minParticipants, input.cadenceSec, input.durationSec, input.residualBehavior],
    );
    await t.query("insert into memberships (circle_id, address, role) values ($1, $2, 'ORGANIZER')", [id, key(organizer)]);
  });
  await logActivity(organizer, "CIRCLE_CREATED", { name }, { circleId: id });
  return getCircle(id);
}

export async function getCircle(id: string): Promise<CircleRecord> {
  const [row] = await (await db()).query<CircleRow>(`${SELECT} where c.id = $1`, [id]);
  if (!row) throw new NotFoundError("This circle does not exist.");
  return toCircle(row);
}

/** Circles the viewer may see: their own plus every public circle, newest first. */
export async function visibleCircles(address: string): Promise<CircleRecord[]> {
  const rows = await (await db()).query<CircleRow>(
    `${SELECT} where c.visibility = 'PUBLIC' or exists (select 1 from memberships m where m.circle_id = c.id and m.address = $1) order by c.created_at desc`,
    [key(address)],
  );
  return rows.map(toCircle);
}

export async function myCircles(address: string): Promise<CircleRecord[]> {
  const rows = await (await db()).query<CircleRow>(`${SELECT} where exists (select 1 from memberships m where m.circle_id = c.id and m.address = $1) order by c.created_at desc`, [key(address)]);
  return rows.map(toCircle);
}

export async function membership(circleId: string, address: string): Promise<"ORGANIZER" | "MEMBER" | undefined> {
  const [row] = await (await db()).query<{ role: string }>("select role from memberships where circle_id = $1 and address = $2", [circleId, key(address)]);
  return row?.role as "ORGANIZER" | "MEMBER" | undefined;
}

/** Private circles are visible only to members; public and invite-only circles to anyone signed in. */
export async function viewableCircle(id: string, viewer: Address): Promise<CircleRecord> {
  const circle = await getCircle(id);
  if (circle.visibility === "PRIVATE" && !(await membership(id, viewer))) throw new NotFoundError("This circle is private. Ask its organizer to add you.");
  return circle;
}

/** Idempotent. Invite-only circles consume a single-use invite; private circles cannot be joined from outside. */
export async function joinCircle(circleId: string, address: Address, inviteCode?: string): Promise<void> {
  const circle = await getCircle(circleId);
  if (await membership(circleId, address)) return;
  await ensureUser(address);
  const joined = await (await db()).tx(async (t) => {
    if (circle.visibility === "PRIVATE") throw new CircleError("Private circles are joined only when the organizer adds you.");
    if (circle.visibility === "INVITE_ONLY") {
      const used = await t.query("update invites set used_by = $3, used_at = now() where code_hash = $1 and circle_id = $2 and used_by is null returning code_hash", [inviteHash(inviteCode ?? ""), circleId, key(address)]);
      if (used.length === 0) throw new CircleError("That invite code is invalid or has already been used.");
    }
    return (await t.query("insert into memberships (circle_id, address, role) values ($1, $2, 'MEMBER') on conflict do nothing returning address", [circleId, key(address)])).length > 0;
  });
  if (joined) await logActivity(address, "CIRCLE_JOINED", { name: circle.name }, { circleId });
}

/** Single-use invite. Only its hash is stored, so a database leak does not leak working invites. */
export async function createInvite(circleId: string, organizer: Address): Promise<string> {
  if ((await membership(circleId, organizer)) !== "ORGANIZER") throw new CircleError("Only the organizer can create invites.");
  if ((await getCircle(circleId)).visibility === "PRIVATE") {
    throw new CircleError("Private circles cannot have invite links. Change the circle to invite-only, or add members directly.");
  }
  const code = randomBytes(12).toString("base64url");
  await (await db()).query("insert into invites (code_hash, circle_id, created_by) values ($1, $2, $3)", [inviteHash(code), circleId, key(organizer)]);
  return code;
}

/** Public: what an invite link opens, before the visitor signs in. Used invites still resolve, so the page can say so. */
export async function inviteTarget(code: string): Promise<{ circleId: string; circleName: string; used: boolean }> {
  const [row] = await (await db()).query<{ circle_id: string; name: string; used_by: string | null }>("select i.circle_id, c.name, i.used_by from invites i join circles c on c.id = i.circle_id where i.code_hash = $1", [inviteHash(code)]);
  if (!row) throw new NotFoundError("This invite link is not valid.");
  return { circleId: row.circle_id, circleName: row.name, used: row.used_by !== null };
}
