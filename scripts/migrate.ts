// Applies pending migrations to DATABASE_URL (or the local PGlite) and exits. The server also migrates on boot; this is
// for deploys that run migrations as a separate step.
import { db, resetDb } from "../src/lib/db/client.ts";
import { env } from "../src/lib/env.ts";

const d = await db();
const applied = await d.query<{ id: string }>("select id from schema_migrations order by id");
console.log(`database ${d.kind} (${env().databaseUrl ? "DATABASE_URL" : env().pgliteDir}): ${applied.map((r) => r.id).join(", ")}`);
await resetDb();
