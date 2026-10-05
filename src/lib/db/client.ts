import { resolve } from "node:path";
import { encodeBigints, reviveBigints } from "@sama/api-types";
import { env } from "../env.ts";
import { log } from "../log.ts";
import { MIGRATIONS } from "./schema.ts";

export type Row = Record<string, unknown>;

export type Db = {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  tx<R>(fn: (db: Pick<Db, "query">) => Promise<R>): Promise<R>;
  close(): Promise<void>;
  kind: "postgres" | "pglite";
};

/**
 * One SQL dialect, two drivers. DATABASE_URL selects a real Postgres server (Supabase, Neon, RDS). Without it the server
 * runs embedded Postgres (PGlite) persisted to .sama-db, or in memory when SAMA_PGLITE_DIR=memory:// (tests).
 */
async function connect(): Promise<Db> {
  const url = env().databaseUrl;
  if (url) {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 5, onnotice: () => undefined });
    const run = (s: typeof sql) => async <T extends Row>(text: string, params: unknown[] = []) => (await s.unsafe(text, params as never[])) as unknown as T[];
    return {
      kind: "postgres",
      query: (text, params) => retryUnsent(() => run(sql)(text, params)),
      tx: (fn) => retryUnsent(() => sql.begin((t) => fn({ query: run(t as unknown as typeof sql) })) as Promise<never>),
      close: () => sql.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = env().pgliteDir;
  const lite = await PGlite.create(dir.startsWith("memory://") ? dir : resolve(process.cwd(), dir));
  const run = (s: Pick<typeof lite, "query">) => async <T extends Row>(text: string, params: unknown[] = []) => (await s.query<T>(text, params)).rows;
  return { kind: "pglite", query: run(lite), tx: (fn) => lite.transaction((t) => fn({ query: run(t) })), close: () => lite.close() };
}

/**
 * A pooled socket can be closed by the pooler between requests. postgres.js reports that as "write CONNECTION_CLOSED"
 * when the statement could not be written, so nothing reached the database and one retry on a fresh connection is safe.
 */
async function retryUnsent<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code !== "CONNECTION_CLOSED" || !/^write /.test(e.message ?? "")) throw error;
    log("db.retry_unsent", { error: e.message?.split(" ").slice(0, 2).join(" ") }, "warn");
    return fn();
  }
}

/** Arbitrary constant key for the Postgres advisory lock that serializes migrations across instances. */
const MIGRATION_LOCK = 56_000_000_001;

export async function migrate(db: Db) {
  await db.tx(async (t) => {
    if (db.kind === "postgres") await t.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await t.query("create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())");
    const applied = new Set((await t.query<{ id: string }>("select id from schema_migrations")).map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      for (const statement of m.sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await t.query(statement);
      await t.query("insert into schema_migrations (id) values ($1)", [m.id]);
      log("db.migrated", { id: m.id });
    }
  });
}

let instance: Promise<Db> | undefined;

export function db(): Promise<Db> {
  instance ??= connect().then(async (d) => {
    await migrate(d);
    return d;
  });
  return instance;
}

/** Tests get a fresh in-memory database per suite. */
export async function resetDb() {
  if (instance) await (await instance).close().catch(() => undefined);
  instance = undefined;
}

/** JSON columns hold matcher and plan objects that carry bigints; they round-trip as {"$bigint": "<decimal>"}. */
export const toJson = encodeBigints;

export function fromJson<T>(value: unknown): T {
  return reviveBigints<T>(typeof value === "string" ? JSON.parse(value) : value);
}
