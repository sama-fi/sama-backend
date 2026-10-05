import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PublicClient } from "viem";
import type { RwaPrice } from "@sama/binance";
import { createApp } from "../src/app.ts";
import { resetDb } from "../src/lib/db/client.ts";
import { resetDeps, setDeps } from "../src/lib/deps.ts";
import { resetEnv } from "../src/lib/env.ts";
import { resetDisplayCache } from "../src/lib/market.ts";
import { Client, DEV_KEYS, testEnv } from "./helpers.ts";

/**
 * The API without a network: dev login, a fake Binance feed and a chain double that reports empty wallets. Covers
 * sessions, assets, settings, circles, invites, target validation and the error contract. Round flows run against a
 * BSC fork in e2e.fork.test.ts.
 */
let app: ReturnType<typeof createApp>;
let alice: Client;
let bob: Client;
let carol: Client;

beforeAll(async () => {
  testEnv();
  resetEnv();
  await resetDb();
  resetDeps();
  resetDisplayCache();
  const price = (a: string): RwaPrice => ({ tokenContractAddress: a, platformId: "bstock", tokenPrice: "100", referencePrice: "100", updatedAtMs: Date.now() });
  setDeps({
    fetchPrices: async (addresses) => new Map(addresses.map((a) => [a.toLowerCase(), price(a)])),
    fetchStatus: async () => new Map(),
    client: () => ({ multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ status: "success", result: 0n })) }) as unknown as PublicClient,
  });
  app = createApp();
  alice = await new Client(app, DEV_KEYS[0]).login();
  bob = await new Client(app, DEV_KEYS[1]).login();
  carol = await new Client(app, DEV_KEYS[2]).login();
});

afterAll(async () => {
  await resetDb();
  resetDeps();
});

describe("session", () => {
  it("binds the dev-login wallet to an httpOnly cookie and reports it", async () => {
    expect(alice.cookie).toMatch(/^sama_session=/);
    expect((await alice.get("/api/session")).body).toEqual({ user: { address: alice.address } });
    const anon = new Client(app, DEV_KEYS[3]);
    expect((await anon.get("/api/session")).body).toEqual({ user: null });
    expect((await anon.get("/api/me/settings")).status).toBe(401);
  });

  it("rejects a stale or forged dev login", async () => {
    const c = new Client(app, DEV_KEYS[3]);
    const stale = `Sama dev login ${c.address} ${Math.floor(Date.now() / 1000) - 3_600}`;
    expect((await c.post("/api/session/dev", { address: c.address, message: stale, signature: await c.account.signMessage({ message: stale }) })).status).toBe(401);
    const fresh = `Sama dev login ${c.address} ${Math.floor(Date.now() / 1000)}`;
    const forged = await alice.account.signMessage({ message: fresh });
    expect((await c.post("/api/session/dev", { address: c.address, message: fresh, signature: forged })).status).toBe(401);
  });

  it("refuses Privy exchange without a token and clears the cookie on logout", async () => {
    const c = new Client(app, DEV_KEYS[3]);
    expect((await c.post("/api/session", {})).status).toBe(400);
    const signedIn = await new Client(app, DEV_KEYS[3]).login();
    const out = await signedIn.call("DELETE", "/api/session");
    expect(out.status).toBe(200);
    expect(signedIn.cookie).toBe("sama_session=");
  });
});

describe("assets", () => {
  it("serves USDT plus every bStock with tier, multiplier, disclosure and logo", async () => {
    const { status, body } = await alice.get("/api/assets");
    expect(status).toBe(200);
    expect(body.length).toBe(89);
    expect(body[0]).toMatchObject({ symbol: "USDT", class: "CASH", priceUsd: 1, uid: "56:0x55d398326f99059fF775485246999027B3197955" });
    const nvda = body.find((a: { symbol: string }) => a.symbol === "NVDAB");
    expect(nvda).toMatchObject({ class: "STOCK", tier: "A", priceUsd: 100, logoUrl: "/assets/NVDAB.png" });
    expect(nvda.disclosure).toMatch(/backed 1:1/);
    expect(nvda.uiMultiplier).toBeGreaterThan(1);
  });
});

describe("settings", () => {
  it("returns defaults, validates and saves", async () => {
    expect((await bob.get("/api/me/settings")).body).toEqual({ notify: { email: true, telegram: false, inApp: true }, residualStyle: "ECONOMIC", costCapBps: 100, gasSponsorship: false });
    const bad = await bob.post("/api/me/settings", { notify: { email: true, telegram: false, inApp: true }, residualStyle: "YOLO", costCapBps: 100, gasSponsorship: false });
    expect(bad.status).toBe(400);
    const saved = await bob.post("/api/me/settings", { notify: { email: false, telegram: true, inApp: true }, residualStyle: "CARRY_FORWARD", costCapBps: 40, gasSponsorship: true });
    expect(saved.body).toEqual({ notify: { email: false, telegram: true, inApp: true }, residualStyle: "CARRY_FORWARD", costCapBps: 40, gasSponsorship: false });
  });
});

describe("targets", () => {
  it("rejects unknown symbols and totals other than 100% before touching the chain", async () => {
    expect((await alice.post("/api/me/target/preview", { weights: { NVDAB: 50, DOGE: 50 }, costCapBps: 100, residualStyle: "ECONOMIC" })).body).toEqual({ ok: false, problems: ["DOGE is not an asset Sama trades."], trades: [] });
    expect((await alice.post("/api/me/target/preview", { weights: { NVDAB: 50, SPYB: 40 }, costCapBps: 100, residualStyle: "ECONOMIC" })).body.problems).toEqual(["Weights add up to 90.0%, not 100%."]);
    const save = await alice.post("/api/me/target", { weights: { NVDAB: 50, SPYB: 40 }, costCapBps: 100, residualStyle: "ECONOMIC" });
    expect(save.status).toBe(400);
  });

  it("lets a new user with an empty wallet save a valid target, with a note instead of trades", async () => {
    expect((await alice.get("/api/me/target")).body).toEqual({ target: null });
    const { body } = await alice.post("/api/me/target/preview", { weights: { NVDAB: 50, USDT: 50 }, costCapBps: 100, residualStyle: "ECONOMIC" });
    expect(body).toMatchObject({ ok: true, trades: [] });
    expect(body.problems[0]).toMatch(/holds no bStocks or USDT/);
    expect((await alice.post("/api/me/target", { weights: { NVDAB: 50, USDT: 50 }, costCapBps: 80, residualStyle: "CARRY_FORWARD" })).status).toBe(200);
    expect((await alice.get("/api/me/target")).body.target).toMatchObject({ weights: { NVDAB: 50, USDT: 50 }, costCapBps: 80, residualStyle: "CARRY_FORWARD" });
    expect((await alice.get("/api/me/activity")).body.activity[0]).toMatchObject({ kind: "TARGET_SAVED" });
  });
});

describe("circles and invites", () => {
  let publicId = "";
  let inviteOnlyId = "";

  it("validates and creates circles; the organizer is a member", async () => {
    expect((await alice.post("/api/circles", { name: "x", description: "", visibility: "PUBLIC", assetSymbols: ["NVDAB", "SPYB"], cadenceSec: null, durationSec: 600, minParticipants: 2, residualBehavior: "ECONOMIC" })).status).toBe(409);
    expect((await alice.post("/api/circles", { name: "Tech", description: "", visibility: "PUBLIC", assetSymbols: ["NVDAB", "NVDAon"], cadenceSec: null, durationSec: 600, minParticipants: 2, residualBehavior: "ECONOMIC" })).body.error).toMatch(/NVDAON is not an asset/);
    const created = await alice.post("/api/circles", { name: "US Big Tech", description: "weekly", visibility: "PUBLIC", assetSymbols: ["NVDAB", "aaplb", "USDT"], cadenceSec: 604_800, durationSec: 600, minParticipants: 2, residualBehavior: "ECONOMIC" });
    expect(created.status).toBe(200);
    publicId = created.body.id;
    const view = (await alice.get(`/api/circles/${publicId}`)).body;
    expect(view).toMatchObject({ name: "US Big Tech", assetSymbols: ["NVDAB", "AAPLB", "USDT"], role: "ORGANIZER", memberCount: 1, liveRound: null, history: [] });
    expect(view.nextRoundAt).not.toBeNull();
  });

  it("lists public circles to others, and lets them join", async () => {
    const list = (await bob.get("/api/circles")).body.circles;
    expect(list.map((c: { id: string }) => c.id)).toContain(publicId);
    expect(list.find((c: { id: string }) => c.id === publicId).role).toBeNull();
    expect((await bob.post(`/api/circles/${publicId}/join`)).status).toBe(200);
    expect((await bob.get(`/api/circles/${publicId}`)).body).toMatchObject({ role: "MEMBER", memberCount: 2 });
  });

  it("invite-only circles take a single-use invite resolvable without signing in", async () => {
    inviteOnlyId = (await alice.post("/api/circles", { name: "Komunitas Jakarta", description: "", visibility: "INVITE_ONLY", assetSymbols: ["SPYB", "QQQB", "USDT"], cadenceSec: null, durationSec: 3_600, minParticipants: 2, residualBehavior: "CARRY_FORWARD" })).body.id;
    expect((await bob.post(`/api/circles/${inviteOnlyId}/invite`)).status).toBe(409);
    const { url } = (await alice.post(`/api/circles/${inviteOnlyId}/invite`)).body;
    expect(url).toMatch(/^http:\/\/localhost:3200\/invite\/[\w-]{16}$/);
    const code = url.split("/").pop();
    const anon = new Client(app, DEV_KEYS[3]);
    expect((await anon.get(`/api/invites/${code}`)).body).toEqual({ circleId: inviteOnlyId, circleName: "Komunitas Jakarta", used: false });
    expect((await carol.post(`/api/circles/${inviteOnlyId}/join`, {})).status).toBe(409);
    expect((await carol.post(`/api/circles/${inviteOnlyId}/join`, { invite: code })).status).toBe(200);
    expect((await bob.post(`/api/circles/${inviteOnlyId}/join`, { invite: code })).body.error).toMatch(/invalid or has already been used/);
    expect((await anon.get(`/api/invites/${code}`)).body.used).toBe(true);
    expect((await anon.get("/api/invites/nope")).status).toBe(404);

    const created = await alice.post("/api/circles", { name: "Tim Tertutup", description: "", visibility: "PRIVATE", assetSymbols: ["SPYB", "USDT"], cadenceSec: null, durationSec: 3_600, minParticipants: 2, residualBehavior: "CARRY_FORWARD" });
    expect(created.status).toBe(200);
    const privateId = created.body.id;
    const privateInvite = await alice.post(`/api/circles/${privateId}/invite`);
    expect(privateInvite.status).toBe(409);
    expect(privateInvite.body.error).toMatch(/Private circles cannot have invite links/);
    expect((await carol.get(`/api/circles/${privateId}`)).body.error).toBe("This circle is private. Ask its organizer to add you.");
  });

  it("non-members cannot open a round, and activity records what happened", async () => {
    expect((await carol.post(`/api/circles/${publicId}/round`)).body.error).toMatch(/Join this circle/);
    const kinds = (await alice.get("/api/me/activity")).body.activity.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["CIRCLE_CREATED"]));
    expect((await bob.get("/api/me/activity")).body.activity[0]).toMatchObject({ kind: "CIRCLE_JOINED", detail: { name: "US Big Tech" } });
  });

  it("returns 404 for unknown rounds and circles", async () => {
    expect((await alice.get("/api/rounds/0xdead")).status).toBe(404);
    expect((await alice.get("/api/circles/0xdead")).status).toBe(404);
  });
});
