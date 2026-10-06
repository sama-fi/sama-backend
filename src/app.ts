import { randomUUID } from "node:crypto";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { encodeBigints, reviveBigints, type NewCircle, type Settings } from "@sama/api-types";
import type { PortfolioIntent } from "@sama/portfolio";
import { circleView } from "./lib/circle-view.ts";
import { createCircle, createInvite, inviteTarget, joinCircle, viewableCircle, visibleCircles } from "./lib/circles.ts";
import { db } from "./lib/db/client.ts";
import { deps } from "./lib/deps.ts";
import { env } from "./lib/env.ts";
import { AuthError, classify, InputError, RoundError } from "./lib/errors.ts";
import { portfolioHistory, recordSnapshot } from "./lib/history.ts";
import { proofData } from "./lib/proof.ts";
import { log, requestContext } from "./lib/log.ts";
import { assetList, loadPortfolio, toWirePortfolio } from "./lib/market.ts";
import { decide, swapBuild, swapPrepare, swapRecord } from "./lib/residuals.ts";
import { approvalPayload, closeCollection, currentOrOpenRound, getRound, intentSigningPayload, prepareIntent, recordSettlement, settleCall, submitApproval, submitIntent } from "./lib/rounds.ts";
import { clearedSessionCookie, requireSession, sessionCookie, type Session } from "./lib/session.ts";
import { assist } from "./lib/assistant.ts";
import { agentInterpreter, checkTarget, normalizeTarget, suggestTarget, toWirePreview, toWireTarget, type TargetInput } from "./lib/targets.ts";
import { getSettings, getTarget, onboardingDone, pageActivity, saveOnboardingDone, saveSettings, saveTarget, settingsProblems, upsertUser, type ActivityGroup, type ActivityQuery } from "./lib/users.ts";
import { syncTransfers } from "./lib/transfers.ts";
import { clearPreview, homeView, roundView } from "./lib/views.ts";

type Ctx = { request: Request; params: Record<string, string>; body: unknown; query: Record<string, string | undefined> };
type Run = (input: { session: Session; params: Record<string, string>; body: unknown; query: Record<string, string | undefined>; request: Request }) => Promise<unknown>;
type PublicRun = (input: { params: Record<string, string>; body: unknown; query: Record<string, string | undefined>; request: Request }) => Promise<unknown>;

const ACTIVITY_GROUPS: readonly ActivityGroup[] = ["rounds", "circles", "targets", "leftovers", "transfers"];
const ACTIVITY_RANGE_DAYS: Record<string, number> = { week: 7, month: 30 };

/** Reads the Activity page's query string; anything malformed is a 400, not a silent full list. */
function activityQuery(query: Record<string, string | undefined>): ActivityQuery {
  const limit = query.limit === undefined ? 30 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InputError("limit must be a whole number from 1 to 100.");
  const group = query.group === undefined || query.group === "all" ? null : query.group;
  if (group !== null && !(ACTIVITY_GROUPS as readonly string[]).includes(group)) throw new InputError("Unknown activity group.");
  const days = query.range === undefined || query.range === "all" ? null : ACTIVITY_RANGE_DAYS[query.range];
  if (query.range !== undefined && query.range !== "all" && days === undefined) throw new InputError("Unknown activity range.");
  return { limit, cursor: query.cursor ?? null, group: group as ActivityGroup | null, sinceMs: days ? Date.now() - days * 86_400_000 : null };
}

/** Bigints cross the wire as {"$bigint": "..."}; the frontend's live client revives them. */
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(encodeBigints(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/**
 * Every route runs here: request id, structured log, optional session, and error classification. Expected failures
 * become 4xx/503 with a message the user can act on; anything else is logged and returned as 500 with its first line.
 */
async function handle(ctx: Ctx, fn: Run | PublicRun, auth: boolean): Promise<Response> {
  const requestId = ctx.request.headers.get("x-request-id") ?? randomUUID();
  const path = new URL(ctx.request.url).pathname;
  const started = performance.now();
  return requestContext.run({ requestId }, async () => {
    const respond = (response: Response) => {
      response.headers.set("x-request-id", requestId);
      log("api.request", { method: ctx.request.method, path, status: response.status, ms: Math.round(performance.now() - started) }, response.status >= 500 ? "error" : "info");
      return response;
    };
    try {
      const body = ctx.body === undefined || ctx.body === null || ctx.body === "" ? {} : reviveBigints(ctx.body);
      const input = { params: ctx.params ?? {}, body, query: ctx.query ?? {}, request: ctx.request };
      if (!auth) return respond(json(await (fn as PublicRun)(input)));
      const session = await requireSession(ctx.request);
      const store = requestContext.getStore();
      if (store) store.user = session.address;
      return respond(json(await (fn as Run)({ ...input, session })));
    } catch (error) {
      const known = classify(error);
      if (known) return respond(json({ error: known.message, requestId }, known.status));
      log("api.error", { path, error: (error as Error).message.split("\n")[0], stack: (error as Error).stack?.split("\n").slice(1, 4) }, "error");
      return respond(json({ error: `Unexpected server error (request ${requestId.slice(0, 8)}). ${(error as Error).message.split("\n")[0]}`, requestId }, 500));
    }
  });
}

const authed = (fn: Run) => (ctx: Ctx) => handle(ctx, fn, true);
const open = (fn: PublicRun) => (ctx: Ctx) => handle(ctx, fn, false);

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new InputError(`${name} is required.`);
  return v;
};
const hex = (v: unknown, name: string): Hex => {
  const s = str(v, name);
  if (!/^0x[0-9a-fA-F]*$/.test(s)) throw new InputError(`${name} must be 0x-prefixed hex.`);
  return s as Hex;
};

export function createApp() {
  const e = env();
  return (
    new Elysia()
      .use(cors({ origin: e.allowedOrigins, credentials: true, methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: ["content-type", "x-request-id"], exposeHeaders: ["x-request-id"] }))
      // A state-changing request from an origin outside the allowlist is refused before any handler runs. CORS alone
      // only stops the response from being read; this stops the side effect.
      .onBeforeHandle(({ request }) => {
        const origin = request.headers.get("origin");
        if (origin && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !e.allowedOrigins.includes(origin)) return json({ error: "Origin not allowed." }, 403);
      })

      // Health ---------------------------------------------------------------------------------------------------------
      .get("/api/health", async () => {
        try {
          const d = await db();
          await d.query("select 1");
          return json({ ok: true, database: d.kind, chainId: e.chainId, settlementContract: e.settlementContract, binance: Boolean(e.binanceKey && e.binanceSecret), privy: Boolean(e.privyAppId && e.privyAppSecret) });
        } catch {
          return json({ ok: false, database: "unreachable" }, 503);
        }
      })

      // Session --------------------------------------------------------------------------------------------------------
      .post("/api/session", async (ctx) => {
        try {
          const { token, address } = (ctx.body ?? {}) as { token?: string; address?: string };
          if (!token || !address) return json({ error: "token and address are required" }, 400);
          const identity = await deps().verifyPrivy(token, address);
          const user = await upsertUser({ address: identity.address, privyUserId: identity.privyUserId, walletKind: identity.walletKind, email: identity.email });
          const cookie = await sessionCookie({ address: identity.address, privyUserId: identity.privyUserId, walletKind: identity.walletKind });
          return json({ user: { address: identity.address, onboardingDone: user.onboardingDone } }, 200, { "set-cookie": cookie });
        } catch (error) {
          if (error instanceof AuthError) return json({ error: error.message }, 401);
          log("session.error", { error: (error as Error).message.split("\n")[0] }, "error");
          return json({ error: "Could not verify the Privy session." }, 401);
        }
      })
      .get("/api/session", async ({ request }) => {
        const session = await requireSession(request).catch(() => undefined);
        return json({ user: session ? { address: session.address, onboardingDone: await onboardingDone(session.address) } : null });
      })
      .delete("/api/session", () => json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() }))
      // Local development and e2e scripts only: sign "Sama dev login <address> <unix seconds>" with the wallet's key.
      .post("/api/session/dev", async (ctx) => {
        if (!e.devAuth) return json({ error: "Not found" }, 404);
        const { address, message, signature } = (ctx.body ?? {}) as { address?: string; message?: string; signature?: Hex };
        if (!address || !message || !signature || !isAddress(address, { strict: false })) return json({ error: "address, message and signature are required" }, 400);
        const match = /^Sama dev login (0x[0-9a-fA-F]{40}) (\d+)$/.exec(message);
        if (!match || match[1]?.toLowerCase() !== address.toLowerCase() || Math.abs(deps().nowSec() - Number(match[2])) > 300) return json({ error: "Stale or malformed dev login message." }, 401);
        if (!(await verifyMessage({ address: getAddress(address), message, signature }))) return json({ error: "Signature does not match the address." }, 401);
        const user = await upsertUser({ address: getAddress(address), walletKind: "dev" });
        return json({ user: { address: getAddress(address), onboardingDone: user.onboardingDone } }, 200, { "set-cookie": await sessionCookie({ address: getAddress(address), privyUserId: null, walletKind: "dev" }) });
      })

      // Assets, invites and proof (public) -------------------------------------------------------------------------------
      .get("/api/assets", open(async () => assetList()))
      .get("/api/proof", open(async () => proofData()))
      .get("/api/invites/:code", open(async ({ params }) => {
        const t = await inviteTarget(str(params.code, "code"));
        return { circleId: t.circleId, circleName: t.circleName, used: t.used };
      }))

      // Me -------------------------------------------------------------------------------------------------------------
      .get("/api/me/home", authed(async ({ session }) => {
        const home = await homeView(session.address);
        await recordSnapshot(session.address, home.portfolio).catch(() => undefined);
        return home;
      }))
      .get("/api/me/portfolio", authed(async ({ session }) => {
        const [portfolio, target] = await Promise.all([loadPortfolio(session.address), getTarget(session.address)]);
        const wire = toWirePortfolio(portfolio);
        await recordSnapshot(session.address, wire).catch(() => undefined);
        return { portfolio: wire, target: target ? toWireTarget(target) : null };
      }))
      .get("/api/me/portfolio/history", authed(async ({ session, query }) => ({ points: await portfolioHistory(session.address, query.range ?? "1D", toWirePortfolio(await loadPortfolio(session.address))) })))
      .post("/api/me/target/preview", authed(async ({ session, body }) => {
        let target;
        try {
          target = normalizeTarget(body as TargetInput);
        } catch (error) {
          if (error instanceof InputError) return { ok: false, problems: [error.message], trades: [] };
          throw error;
        }
        return toWirePreview(await checkTarget(session.address, target));
      }))
      // AI helper: turns a sentence into weights the user then edits and saves. Off unless a provider key is set.
      .get("/api/agent", open(async () => ({ enabled: agentInterpreter() !== null })))
      .post("/api/me/assistant", authed(async ({ session, body }) => assist(session.address, str((body as { message?: unknown } | null)?.message, "message"))))
      .post("/api/me/target/suggest", authed(async ({ session, body }) => {
        const instruction = str((body as { instruction?: unknown } | null)?.instruction, "instruction");
        return suggestTarget(session.address, instruction);
      }))
      .get("/api/me/target", authed(async ({ session }) => {
        const t = await getTarget(session.address);
        return { target: t ? toWireTarget(t) : null };
      }))
      // Saves a target only after the deterministic resolver accepts it against the wallet's live holdings.
      .post("/api/me/target", authed(async ({ session, body }) => {
        const target = normalizeTarget(body as TargetInput);
        const check = await checkTarget(session.address, target);
        if (!check.ok && !check.emptyWallet) throw new InputError(check.problems.join(" "));
        await saveTarget(session.address, target);
        const saved = await getTarget(session.address);
        return { ok: true, target: saved ? toWireTarget(saved) : null };
      }))
      .get("/api/me/settings", authed(async ({ session }) => getSettings(session.address)))
      .post("/api/me/settings", authed(async ({ session, body }) => {
        const s = body as Settings;
        const problems = settingsProblems(s);
        if (problems.length) throw new InputError(problems.join(" "));
        await saveSettings(session.address, s);
        return getSettings(session.address);
      }))
      .get("/api/me/onboarding", authed(async ({ session }) => ({ onboardingDone: await onboardingDone(session.address) })))
      .post("/api/me/onboarding", authed(async ({ session, body }) => {
        const done = (body as { done?: unknown })?.done;
        if (typeof done !== "boolean") throw new InputError("done must be a boolean.");
        await saveOnboardingDone(session.address, done);
        return { onboardingDone: done };
      }))
      // One page at a time: `limit` (default 30), `cursor` from the last response, `group` and `range` filter on the server.
      .get("/api/me/activity", authed(async ({ session, query }) => {
        const page = await pageActivity(session.address, activityQuery(query));
        return { activity: page.items, nextCursor: page.nextCursor };
      }))
      // The wallet sends a token itself; this scans the chain right away so the transfer shows in Activity without waiting for the cron.
      .post("/api/me/transfers/sync", authed(async () => ({ ok: true, ...(await syncTransfers()) })))

      // Circles --------------------------------------------------------------------------------------------------------
      .get("/api/circles", authed(async ({ session }) => ({ circles: await Promise.all((await visibleCircles(session.address)).map((c) => circleView(c, session.address))) })))
      .post("/api/circles", authed(async ({ session, body }) => ({ id: (await createCircle(session.address, body as NewCircle)).id })))
      .get("/api/circles/:id", authed(async ({ session, params }) => circleView(await viewableCircle(str(params.id, "id"), session.address), session.address)))
      .post("/api/circles/:id/join", authed(async ({ session, params, body }) => {
        const invite = (body as { invite?: string }).invite;
        await joinCircle(str(params.id, "id"), session.address, typeof invite === "string" && invite.trim() ? invite.trim() : undefined);
        return { ok: true };
      }))
      .post("/api/circles/:id/invite", authed(async ({ session, params }) => ({ url: `${e.appOrigin}/invite/${await createInvite(str(params.id, "id"), session.address)}` })))
      // Enter the lobby: the circle's live round, opening one with a fresh snapshot when none is running.
      .post("/api/circles/:id/round", authed(async ({ session, params }) => ({ roundId: (await currentOrOpenRound(str(params.id, "id"), session.address)).id })))

      // Rounds ---------------------------------------------------------------------------------------------------------
      .get("/api/rounds/:id", authed(async ({ session, params }) => roundView(str(params.id, "id"), session.address)))
      // GET builds the unsigned intent and its EIP-712 payload; POST accepts the wallet's signature over it.
      .get("/api/rounds/:id/intent", authed(async ({ session, params }) => {
        const prepared = await prepareIntent(str(params.id, "id"), session.address);
        const round = await getRound(str(params.id, "id"));
        return { ...prepared, typedData: intentSigningPayload(prepared.intent, round) };
      }))
      .post("/api/rounds/:id/intent", authed(async ({ session, params, body }) => {
        const { intent, signature } = body as { intent?: PortfolioIntent; signature?: Hex };
        if (!intent) throw new InputError("intent is required.");
        const status = await submitIntent(str(params.id, "id"), session.address, intent, hex(signature, "signature"));
        clearPreview(str(params.id, "id"), session.address);
        return { status };
      }))
      .post("/api/rounds/:id/close", authed(async ({ session, params }) => ({ state: (await closeCollection(str(params.id, "id"), session.address)).state })))
      .get("/api/rounds/:id/approval", authed(async ({ session, params }) => {
        const round = await getRound(str(params.id, "id"));
        if (!round.plan) throw new RoundError("This round has no plan to approve.");
        return approvalPayload(round.plan, session.address);
      }))
      .post("/api/rounds/:id/approval", authed(async ({ session, params, body }) => ({ state: (await submitApproval(str(params.id, "id"), session.address, hex((body as { signature?: string }).signature, "signature"))).state })))
      // GET returns the settle() call for the participant's wallet to send; POST reports the hash and verifies it.
      .get("/api/rounds/:id/settle", authed(async ({ params }) => settleCall(await getRound(str(params.id, "id")))))
      .post("/api/rounds/:id/settle", authed(async ({ session, params, body }) => ({ state: (await recordSettlement(str(params.id, "id"), session.address, hex((body as { txHash?: string }).txHash, "txHash"))).state })))
      .post("/api/rounds/:id/residual", authed(async ({ session, params, body }) => {
        const { choice, engineDecision } = body as { choice?: string; engineDecision?: string };
        if (choice !== "CARRY_FORWARD" && choice !== "CANCEL") throw new InputError("Choose carry forward or cancel.");
        await decide(await getRound(str(params.id, "id")), session.address, choice, engineDecision || "NONE");
        return { ok: true };
      }))
      // Leftover swap from the user's own wallet in three calls: prepare (approval or quote), build (swap tx), record.
      .post("/api/rounds/:id/residual/swap", authed(async ({ session, params, body }) => {
        const input = body as { step?: string; txHash?: string };
        const round = await getRound(str(params.id, "id"));
        if (input.step === "prepare") return swapPrepare(round, session.address);
        if (input.step === "build") return { tx: await swapBuild(round, session.address) };
        if (input.step === "record") return swapRecord(round, session.address, hex(input.txHash, "txHash"));
        throw new InputError("Unknown swap step.");
      }))
  );
}
