import type { AssistantAction, AssistantBlock, AssistantReply, AssistantTurn, HistoryRange } from "@sama/api-types";
import type { Address } from "viem";
import { circleView } from "./circle-view.ts";
import { viewableCircle, visibleCircles } from "./circles.ts";
import { env } from "./env.ts";
import { InputError } from "./errors.ts";
import { portfolioHistory } from "./history.ts";
import { log } from "./log.ts";
import { assetList, loadPortfolio, toWirePortfolio } from "./market.ts";
import { agentInterpreter, checkTarget, normalizeTarget, toWirePreview } from "./targets.ts";
import { pageActivity } from "./users.ts";
import { homeView } from "./views.ts";

const MAX_TURNS = 12;
const MAX_STEPS = 6;
const MAX_TOOL_CHARS = 12_000;

const SYSTEM = `You are Sama's assistant, inside the Sama app. Sama lets people rebalance portfolios of bStocks (tokenized US stocks on BNB Chain) and USDT by netting their trades against each other in "Circles", in timed rounds. Tickers look like NVDAB, AAPLB, TSLAB. USDT is the cash asset.

How to work:
- Use the tools for every fact about the user's wallet, target, prices, Circles, rounds or activity. Never guess or recall numbers; if a tool does not give it, say you do not know.
- You can only read and propose. You cannot move funds, save a target, join a Circle or sign anything. To suggest one of those, call the matching propose_* tool: the user then sees a button and decides. Say plainly that they need to confirm.
- For a target change: read get_overview first, work out sensible whole-percent weights that add up to 100 using only assets from search_assets or the wallet, check them with preview_target, then call propose_target. Explain the trade-off in a sentence or two.
- Weights are whole percents. USDT counts as cash. Leveraged assets decay when held; mention it if you propose one.
- Answer in the user's language (Indonesian or English). Be brief and concrete: short paragraphs or a few bullets, no filler, no markdown headings. Amounts in USD with two decimals.
- You give no investment advice or predictions; you explain, compare and help set up what the user asks for.
- If asked something unrelated to Sama or portfolios, say briefly that you only help with Sama.`;

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message = { role: "system" | "user" | "assistant" | "tool"; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };

type Ctx = { address: Address; blocks: AssistantBlock[]; actions: AssistantAction[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const num = { type: "number" } as const;
const str = { type: "string" } as const;
const weightsSchema = { type: "object", description: "Whole-percent weight per ticker, adding up to 100. Use USDT for cash.", additionalProperties: num };

/** Tool definitions in the OpenAI function-calling shape. Everything here only reads, or records a proposal. */
const TOOLS = [
  { name: "get_overview", description: "The user's home view: portfolio value and positions, saved target, drift from it, their Circles, rounds waiting on them and recent activity.", parameters: { type: "object", properties: {} } },
  { name: "get_portfolio", description: "The wallet's positions: amount, USD value and share of the total, including BNB and other tokens that Sama does not trade.", parameters: { type: "object", properties: {} } },
  { name: "get_prices", description: "Live USD prices. Accepts tickers (NVDAB or NVDA) or company names.", parameters: { type: "object", properties: { symbols: { type: "array", items: str } }, required: ["symbols"] } },
  { name: "search_assets", description: "Search the tradable asset list by ticker or name. Returns class, tier (A is most liquid), leverage flag and price. Empty query lists the first assets.", parameters: { type: "object", properties: { query: str, limit: num } } },
  { name: "search_circles", description: "Find Circles the user may see (public ones or their own) by name, description or asset tickers. Empty query lists recent ones. Shown to the user as cards.", parameters: { type: "object", properties: { query: str } } },
  { name: "get_circle", description: "Details of one Circle: rules, members, live round and past rounds.", parameters: { type: "object", properties: { circle_id: str }, required: ["circle_id"] } },
  { name: "get_activity", description: "The user's recent activity feed (transfers, rounds, target changes).", parameters: { type: "object", properties: { limit: num } } },
  { name: "portfolio_history", description: "Wallet value over time, summarised: start, end, change, low and high.", parameters: { type: "object", properties: { range: { type: "string", enum: ["1H", "1D", "1W", "1M", "1Y", "ALL"] } }, required: ["range"] } },
  { name: "preview_target", description: "What trades a set of weights would cause against the live wallet, or why they are invalid. Changes nothing.", parameters: { type: "object", properties: { weights: weightsSchema }, required: ["weights"] } },
  { name: "propose_target", description: "Offer the user a target. Validates the weights; if valid the user gets an Apply button (they still review and save it). Changes nothing itself.", parameters: { type: "object", properties: { weights: weightsSchema }, required: ["weights"] } },
  { name: "propose_join_circle", description: "Offer the user a Join button for a Circle. Invite-only and private Circles need an invite code, which the user types themselves.", parameters: { type: "object", properties: { circle_id: str }, required: ["circle_id"] } },
  { name: "propose_open", description: "Offer a button that opens a page: /home, /portfolio, /portfolio?tab=target, /circles, /circles/<id>, /activity, /rounds/<id>.", parameters: { type: "object", properties: { path: str, label: str }, required: ["path", "label"] } },
].map((t) => ({ type: "function" as const, function: t }));

type Args = Record<string, unknown>;

const text = (a: Args, k: string): string => (typeof a[k] === "string" ? (a[k] as string).trim() : "");

function weightsOf(a: Args): Record<string, number> {
  const w = a.weights;
  if (!w || typeof w !== "object" || Array.isArray(w)) throw new InputError("weights must be an object like { NVDAB: 40, USDT: 60 }.");
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k.trim().toUpperCase(), Number(v)]));
}

/** The result of validating weights against the live wallet, without saving anything. */
async function previewWeights(ctx: Ctx, weights: Record<string, number>) {
  const target = normalizeTarget({ weights, costCapBps: 100, residualStyle: "ECONOMIC" });
  return toWirePreview(await checkTarget(ctx.address, target));
}

const TOOL_RUNNERS: Record<string, (ctx: Ctx, a: Args) => Promise<unknown>> = {
  get_overview: async (ctx) => homeView(ctx.address),
  get_portfolio: async (ctx) => toWirePortfolio(await loadPortfolio(ctx.address)),
  get_prices: async (ctx, a) => {
    const words = Array.isArray(a.symbols) ? a.symbols.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
    const list = await assetList();
    const items: Array<{ symbol: string; name: string; priceUsd: number }> = [];
    const missing: string[] = [];
    for (const word of words) {
      const w = norm(word);
      const hit = w && list.find((x) => norm(x.symbol) === w || norm(x.symbol) === `${w}b` || norm(x.name).includes(w));
      if (hit) { if (!items.some((i) => i.symbol === hit.symbol)) items.push({ symbol: hit.symbol, name: hit.name, priceUsd: hit.priceUsd }); }
      else missing.push(word);
    }
    if (items.length || missing.length) ctx.blocks.push({ type: "prices", items, missing });
    return { items, notTradedBySama: missing };
  },
  search_assets: async (_ctx, a) => {
    const q = norm(text(a, "query"));
    const limit = Math.min(Math.max(Number(a.limit) || 15, 1), 30);
    const list = (await assetList()).filter((x) => !q || norm(x.symbol).includes(q) || norm(x.name).includes(q));
    return list.slice(0, limit).map((x) => ({ symbol: x.symbol, name: x.name, class: x.class, tier: x.tier, leveraged: x.leveraged ?? false, priceUsd: x.priceUsd }));
  },
  search_circles: async (ctx, a) => {
    const words = text(a, "query").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    const found: Extract<AssistantBlock, { type: "circles" }>["circles"] = [];
    for (const c of await visibleCircles(ctx.address)) {
      const hay = `${c.name} ${c.description} ${c.assetSymbols.join(" ")}`.toLowerCase();
      if (words.length && !words.some((w) => hay.includes(w) || hay.includes(w.replace(/b$/, "")))) continue;
      const view = await circleView(c, ctx.address);
      if (view.visibility !== "PUBLIC" && !view.role) continue;
      found.push({ id: view.id, name: view.name, description: view.description, memberCount: view.memberCount, assetSymbols: view.assetSymbols, role: view.role });
      if (found.length === 6) break;
    }
    // The model may search several times; keep only the latest useful result so the cards are not repeated.
    if (found.length > 0) ctx.blocks = [...ctx.blocks.filter((b) => b.type !== "circles"), { type: "circles", circles: found }];
    else if (!ctx.blocks.some((b) => b.type === "circles")) ctx.blocks.push({ type: "circles", circles: found });
    return found;
  },
  get_circle: async (ctx, a) => {
    const view = await circleView(await viewableCircle(text(a, "circle_id"), ctx.address), ctx.address);
    if (view.visibility !== "PUBLIC" && !view.role) throw new InputError("That Circle is not visible to this user.");
    return view;
  },
  get_activity: async (ctx, a) => (await pageActivity(ctx.address, { limit: Math.min(Math.max(Number(a.limit) || 10, 1), 15) })).items,
  portfolio_history: async (ctx, a) => {
    const range = text(a, "range") as HistoryRange;
    const points = await portfolioHistory(ctx.address, range, toWirePortfolio(await loadPortfolio(ctx.address)));
    if (points.length === 0) return { points: 0 };
    const values = points.map((p) => p.usd);
    const start = points[0]!;
    const end = points[points.length - 1]!;
    return { range, from: new Date(start.t).toISOString(), startUsd: start.usd, endUsd: end.usd, changePct: start.usd > 0 ? ((end.usd - start.usd) / start.usd) * 100 : null, lowUsd: Math.min(...values), highUsd: Math.max(...values), points: points.length };
  },
  preview_target: async (ctx, a) => previewWeights(ctx, weightsOf(a)),
  propose_target: async (ctx, a) => {
    const weights = weightsOf(a);
    const preview = await previewWeights(ctx, weights);
    if (!preview.ok) return { proposed: false, problems: preview.problems };
    const clean = Object.fromEntries(Object.entries(weights).filter(([, v]) => v > 0));
    ctx.actions = ctx.actions.filter((x) => x.type !== "apply_target");
    ctx.actions.push({ type: "apply_target", weights: clean });
    return { proposed: true, note: "The user now sees an Apply button. They still review and save it.", trades: preview.trades };
  },
  propose_join_circle: async (ctx, a) => {
    const view = await circleView(await viewableCircle(text(a, "circle_id"), ctx.address), ctx.address);
    if (view.role) return { proposed: false, note: "The user is already a member." };
    if (view.visibility !== "PUBLIC" && !view.role) throw new InputError("That Circle is not visible to this user.");
    ctx.actions.push({ type: "join_circle", circleId: view.id, name: view.name, needsInvite: view.visibility !== "PUBLIC" });
    return { proposed: true, note: "The user now sees a Join button." };
  },
  propose_open: async (ctx, a) => {
    const path = text(a, "path");
    if (!/^\/(home|portfolio(\?tab=target)?|circles|activity|circles\/[\w-]+|rounds\/[\w-]+)$/.test(path)) throw new InputError("That page is not available.");
    ctx.actions.push({ type: "open", path, label: text(a, "label").slice(0, 60) || path });
    return { proposed: true };
  },
};

function provider() {
  const e = env();
  if (e.agentProvider === "CUSTOM") return { base: (process.env.AI_BASE_URL ?? "").replace(/\/+$/, ""), key: process.env.AI_API_KEY ?? "", model: process.env.AI_MODEL || "gpt-4o-mini" };
  if (e.agentProvider === "GROQ") return { base: "https://api.groq.com/openai/v1", key: process.env.GROQ_API_KEY ?? "", model: "openai/gpt-oss-120b" };
  return null;
}

async function chat(p: NonNullable<ReturnType<typeof provider>>, messages: Message[]): Promise<{ content?: string | null; tool_calls?: ToolCall[] }> {
  const response = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: p.model, temperature: 0.2, messages, tools: TOOLS, tool_choice: "auto" }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(`AI provider returned ${response.status}: ${body.error?.message ?? "no detail"}`);
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error("AI provider returned no message");
  return message;
}

/** Keeps the last turns, each trimmed, and only well-formed ones: the client sends this back for context. */
function cleanHistory(turns: unknown): AssistantTurn[] {
  if (!Array.isArray(turns)) throw new InputError("Send messages as a list of turns.");
  const out = turns
    .filter((t): t is AssistantTurn => !!t && typeof t === "object" && ((t as AssistantTurn).role === "user" || (t as AssistantTurn).role === "assistant") && typeof (t as AssistantTurn).content === "string")
    .map((t) => ({ role: t.role, content: t.content.trim().slice(0, 1_500) }))
    .filter((t) => t.content)
    .slice(-MAX_TURNS);
  if (out.at(-1)?.role !== "user") throw new InputError("Type a question or a request first.");
  return out;
}

/**
 * The assistant. A tool-using model reads the user's real data through the tools above and answers; anything that would
 * change something comes back as an action the user confirms in the app. Nothing here writes to the user's account.
 */
export async function assist(address: Address, turns: unknown): Promise<AssistantReply> {
  if (!agentInterpreter()) throw new InputError("The AI helper is not turned on.");
  const p = provider();
  if (!p) throw new InputError("The assistant needs an OpenAI-compatible AI provider (AI_BASE_URL, AI_API_KEY, AI_MODEL).");
  const history = cleanHistory(turns);
  if ((history.at(-1)?.content.length ?? 0) > 500) throw new InputError("Keep the request under 500 characters.");
  const ctx: Ctx = { address, blocks: [], actions: [] };
  const messages: Message[] = [{ role: "system", content: SYSTEM }, ...history];
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await chat(p, messages);
      if (!reply.tool_calls?.length) return { text: (reply.content ?? "").trim() || "…", blocks: ctx.blocks, actions: ctx.actions };
      messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        let result: unknown;
        try {
          const run = TOOL_RUNNERS[call.function.name];
          if (!run) throw new InputError(`Unknown tool ${call.function.name}.`);
          result = await run(ctx, JSON.parse(call.function.arguments || "{}") as Args);
        } catch (error) {
          result = { error: (error as Error).message.split("\n")[0] };
        }
        const json = JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "null";
        messages.push({ role: "tool", tool_call_id: call.id, content: json.length > MAX_TOOL_CHARS ? `${json.slice(0, MAX_TOOL_CHARS)}…(truncated)` : json });
      }
    }
    return { text: "That took too many steps. Try asking something narrower.", blocks: ctx.blocks, actions: ctx.actions };
  } catch (error) {
    if (error instanceof InputError) throw error;
    log("assistant.failed", { error: (error as Error).message.split("\n")[0] }, "error");
    throw new InputError("The AI helper could not answer right now. Try again.");
  }
}
