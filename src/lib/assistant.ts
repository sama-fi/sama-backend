import { claudeText } from "@sama/agent";
import type { AssistantReply } from "@sama/api-types";
import { z } from "zod";
import type { Address } from "viem";
import { circleView } from "./circle-view.ts";
import { visibleCircles } from "./circles.ts";
import { env } from "./env.ts";
import { InputError } from "./errors.ts";
import { log } from "./log.ts";
import { assetList } from "./market.ts";
import { agentInterpreter, suggestTarget } from "./targets.ts";

const ROUTER_SYSTEM = `You route one message from a user of Sama, an app for rebalancing portfolios of bStocks (tokenized US stocks on BNB Chain) and USDT together with other people in "Circles".
Reply with ONE JSON object and nothing else:
{"intent":"TARGET"|"PRICE"|"CIRCLES"|"OTHER","symbols":string[],"query":string,"reply":string}
- TARGET: the user wants to set or change their portfolio allocation or rebalance ("keep 40% in USDT", "make it safer").
- PRICE: the user asks the price of one or more assets. Put the tickers or company names they wrote in "symbols".
- CIRCLES: the user wants to find, search or list Circles. Put the topic words (asset tickers, name words) in "query"; empty if they want all.
- OTHER: anything else. Put a short helpful answer in "reply" (two sentences at most, in the user's language). Never state prices, balances or circle names: you do not know them.
Always answer in the JSON shape above; use "" and [] for fields that do not apply.`;

const RouteSchema = z.object({
  intent: z.enum(["TARGET", "PRICE", "CIRCLES", "OTHER"]),
  symbols: z.array(z.string()).default([]),
  query: z.string().default(""),
  reply: z.string().default(""),
});
type Route = z.infer<typeof RouteSchema>;

/** One plain chat call to the configured provider; the answer is parsed and validated by the caller. */
async function chatText(system: string, user: string): Promise<string> {
  const e = env();
  if (e.agentProvider === "ANTHROPIC") return claudeText(system, user);
  const custom = e.agentProvider === "CUSTOM";
  const base = custom ? (process.env.AI_BASE_URL ?? "").replace(/\/+$/, "") : "https://api.groq.com/openai/v1";
  const key = custom ? process.env.AI_API_KEY : process.env.GROQ_API_KEY;
  const model = custom ? process.env.AI_MODEL || "gpt-4o-mini" : "openai/gpt-oss-120b";
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(`AI provider returned ${response.status}: ${body.error?.message ?? "no detail"}`);
  return body.choices?.[0]?.message?.content ?? "";
}

async function route(text: string): Promise<Route> {
  const raw = await chatText(ROUTER_SYSTEM, text);
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  const parsed = RouteSchema.safeParse(json ? JSON.parse(json) : null);
  if (!parsed.success) throw new Error("the model did not answer in the expected shape");
  return parsed.data;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Real prices for the assets the user named. Matches a ticker (NVDAB, or NVDA for NVDAB) or part of the company name. */
async function prices(symbols: string[]): Promise<AssistantReply> {
  const list = await assetList();
  const items: Array<{ symbol: string; name: string; priceUsd: number }> = [];
  const missing: string[] = [];
  for (const word of symbols.slice(0, 8)) {
    const w = norm(word);
    const hit = w && list.find((a) => norm(a.symbol) === w || norm(a.symbol) === `${w}b` || norm(a.name).includes(w));
    if (hit) { if (!items.some((i) => i.symbol === hit.symbol)) items.push({ symbol: hit.symbol, name: hit.name, priceUsd: hit.priceUsd }); }
    else missing.push(word);
  }
  if (items.length === 0 && missing.length === 0) return { kind: "answer", text: "Which asset's price do you want? Name a ticker, like NVDAB." };
  return { kind: "prices", items, missing };
}

/** Circles the viewer may see (public ones, or ones they belong to) whose name, description or assets match the words. */
async function circles(address: Address, query: string): Promise<AssistantReply> {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const found = [];
  for (const c of await visibleCircles(address)) {
    const hay = `${c.name} ${c.description} ${c.assetSymbols.join(" ")}`.toLowerCase();
    if (words.length && !words.some((w) => hay.includes(w) || hay.includes(w.replace(/b$/, "")))) continue;
    const view = await circleView(c, address);
    if (view.visibility !== "PUBLIC" && !view.role) continue;
    found.push({ id: view.id, name: view.name, description: view.description, memberCount: view.memberCount, assetSymbols: view.assetSymbols, role: view.role });
    if (found.length === 6) break;
  }
  return { kind: "circles", query, circles: found };
}

/** The assistant: the model picks what the user wants, the server does it with real data. Nothing is saved or joined. */
export async function assist(address: Address, message: string): Promise<AssistantReply> {
  if (!agentInterpreter()) throw new InputError("The AI helper is not turned on.");
  const text = message.trim();
  if (!text) throw new InputError("Type a question or a request first.");
  if (text.length > 500) throw new InputError("Keep the request under 500 characters.");
  let picked: Route;
  try {
    picked = await route(text);
  } catch (error) {
    log("assistant.route_failed", { error: (error as Error).message.split("\n")[0] }, "error");
    throw new InputError("The AI helper could not read that. Try rephrasing it.");
  }
  switch (picked.intent) {
    case "TARGET": {
      const r = await suggestTarget(address, text);
      return r.ok ? { kind: "target", weights: r.weights } : { kind: "problems", problems: r.problems };
    }
    case "PRICE":
      return prices(picked.symbols);
    case "CIRCLES":
      return circles(address, picked.query);
    default:
      return { kind: "answer", text: picked.reply || "I can set your target, check prices and find Circles." };
  }
}
