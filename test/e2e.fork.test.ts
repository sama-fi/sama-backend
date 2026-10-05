import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPublicClient, createWalletClient, erc20Abi, http, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { bscRegistry } from "@sama/assets";
import { BSC_PUBLIC_RPC, bscChain } from "@sama/shared";
import { startAnvil, type Anvil } from "@sama/testkit";
import { createApp } from "../src/app.ts";
import { resetDb } from "../src/lib/db/client.ts";
import { resetDeps } from "../src/lib/deps.ts";
import { env, resetEnv } from "../src/lib/env.ts";
import { resetDisplayCache } from "../src/lib/market.ts";
import { Client, DEV_KEYS, testEnv } from "./helpers.ts";

/**
 * A full round through the HTTP API against a BSC mainnet fork: real bStocks (BeaconProxy, BEP-8056), real Binance
 * prices, real PancakeSwap TWAPs and the deployed SamaSettlement. Three wallets form the ring
 * NVDAB -> SPYB -> AAPLB -> NVDAB, which no pair of them could trade alone.
 *
 *   SAMA_FORK=1 bun test test/e2e.fork.test.ts
 *
 * Needs BINANCE_WEB3_API_KEY / BINANCE_WEB3_API_SECRET (from .env) and network access. Nothing is broadcast to BSC.
 */
const enabled = process.env.SAMA_FORK === "1";
const reg = bscRegistry();
const NVDAB = reg.resolveSymbol("NVDAB");
const SPYB = reg.resolveSymbol("SPYB");
const AAPLB = reg.resolveSymbol("AAPLB");
const E18 = 10n ** 18n;

let anvil: Anvil;
let rpc: PublicClient;
let app: ReturnType<typeof createApp>;
let wallets: Client[];

async function anvilCall(method: string, params: unknown[]) {
  const r = await fetch(anvil.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Moves real tokens to a test wallet by impersonating the reference PancakeSwap pool that holds them (fork only). */
async function fund(token: Address, holder: Address, to: Address, amount: bigint) {
  await anvilCall("anvil_impersonateAccount", [holder]);
  await anvilCall("anvil_setBalance", [holder, `0x${parseEther("1").toString(16)}`]);
  const w = createWalletClient({ account: holder, chain: bscChain(anvil.rpcUrl), transport: http(anvil.rpcUrl) });
  const hash = await w.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount], account: holder, chain: bscChain(anvil.rpcUrl) });
  await rpc.waitForTransactionReceipt({ hash });
  await anvilCall("anvil_stopImpersonatingAccount", [holder]);
}

function walletClient(c: Client) {
  return createWalletClient({ account: c.account, chain: bscChain(anvil.rpcUrl), transport: http(anvil.rpcUrl) });
}

describe.skipIf(!enabled)("round end to end on a BSC mainnet fork", () => {
  // /proof is public: one settled round, circle named (public), no wallet addresses anywhere in the payload.
  async function proof() {
    const anon = new Client(app, DEV_KEYS[3]);
    return (await anon.get("/api/proof")).body;
  }
  beforeAll(async () => {
    anvil = await startAnvil({ forkUrl: process.env.BSC_RPC_URL || BSC_PUBLIC_RPC });
    testEnv({ BSC_RPC_URL: anvil.rpcUrl, VERIFIER_RPC_URL: anvil.rpcUrl, SAMA_MAX_PLAN_USD: "5000" });
    resetEnv();
    await resetDb();
    resetDeps();
    resetDisplayCache();
    rpc = createPublicClient({ chain: bscChain(anvil.rpcUrl), transport: http(anvil.rpcUrl) }) as PublicClient;
    app = createApp();
    wallets = await Promise.all(DEV_KEYS.slice(0, 3).map((k) => new Client(app, k).login()));
    for (const w of wallets) await anvilCall("anvil_setBalance", [w.address, `0x${parseEther("1").toString(16)}`]);
    // About $100 each: 0.43 NVDAB, 0.13 SPYB, 0.30 AAPLB.
    await fund(NVDAB.contractAddress, NVDAB.referencePool!.address, wallets[0]!.address, (43n * E18) / 100n);
    await fund(SPYB.contractAddress, SPYB.referencePool!.address, wallets[1]!.address, (13n * E18) / 100n);
    await fund(AAPLB.contractAddress, AAPLB.referencePool!.address, wallets[2]!.address, (30n * E18) / 100n);
  }, 180_000);

  afterAll(async () => {
    anvil?.stop();
    await resetDb();
    resetDeps();
  });

  let circleId = "";
  let roundId = "";

  it("reads real fork balances into the portfolio", async () => {
    const { body } = await wallets[0]!.get("/api/me/portfolio");
    expect(body.portfolio.ok).toBe(true);
    expect(body.portfolio.positions).toEqual([expect.objectContaining({ symbol: "NVDAB", amountTokens: 0.43 })]);
    expect(body.portfolio.totalUsd).toBeGreaterThan(50);
  }, 60_000);

  it("saves targets that rotate each wallet into the next stock", async () => {
    const targets = [{ SPYB: 100 }, { AAPLB: 100 }, { NVDAB: 100 }];
    for (const [i, weights] of targets.entries()) {
      const preview = await wallets[i]!.post("/api/me/target/preview", { weights, costCapBps: 100, residualStyle: "CARRY_FORWARD" });
      expect(preview.body.ok).toBe(true);
      expect(preview.body.trades.map((t: { side: string }) => t.side).sort()).toEqual(["BUY", "SELL"]);
      expect((await wallets[i]!.post("/api/me/target", { weights, costCapBps: 100, residualStyle: "CARRY_FORWARD" })).status).toBe(200);
    }
  }, 120_000);

  it("creates a circle, the others join, and the organizer opens a round with a Binance + TWAP snapshot", async () => {
    circleId = (await wallets[0]!.post("/api/circles", { name: "Fork ring", description: "e2e", visibility: "PUBLIC", assetSymbols: ["NVDAB", "SPYB", "AAPLB"], cadenceSec: null, durationSec: 900, minParticipants: 3, residualBehavior: "CARRY_FORWARD" })).body.id;
    for (const w of wallets.slice(1)) expect((await w.post(`/api/circles/${circleId}/join`)).status).toBe(200);
    const opened = await wallets[0]!.post(`/api/circles/${circleId}/round`);
    expect(opened.status).toBe(200);
    roundId = opened.body.roundId;
    const view = (await wallets[1]!.get(`/api/rounds/${roundId}`)).body;
    expect(view.round.state).toBe("OPEN");
    expect(view.round.excludedAssets).toEqual([]);
    expect(view.round.prices.map((p: { source: string }) => p.source)).toEqual(["BINANCE+TWAP", "BINANCE+TWAP", "BINANCE+TWAP"]);
    // The unsigned preview is shown before signing: B sells SPYB, buys AAPLB.
    expect(view.you.joinBlocker).toBeNull();
    expect(view.you.intent.map((r: { symbol: string; side: string }) => `${r.side} ${r.symbol}`).sort()).toEqual(["BUY AAPLB", "SELL SPYB"]);
  }, 120_000);

  it("every member signs the EIP-712 intent; the matcher finds the three-wallet ring", async () => {
    for (const w of wallets) {
      const { body } = await w.get(`/api/rounds/${roundId}/intent`);
      const signature = await w.account.signTypedData(body.typedData);
      expect((await w.post(`/api/rounds/${roundId}/intent`, { intent: body.intent, signature })).body.status).toBe("ACCEPTED");
    }
    const view = (await wallets[0]!.get(`/api/rounds/${roundId}`)).body;
    expect(view.round.state).toBe("PROPOSED");
    expect(view.aggregate.cycleCount).toBeGreaterThanOrEqual(1);
    expect(view.aggregate.participants).toBe(3);
    expect(view.you.legs.map((l: { direction: string; symbol: string }) => `${l.direction} ${l.symbol}`).sort()).toEqual(["RECEIVE SPYB", "SEND NVDAB"]);
  }, 120_000);

  it("each participant approves the exact plan and sets exact allowances", async () => {
    for (const w of wallets) {
      const { body } = await w.get(`/api/rounds/${roundId}/approval`);
      const signature = await w.account.signTypedData(body.typedData);
      await w.post(`/api/rounds/${roundId}/approval`, { signature });
      const view = (await w.get(`/api/rounds/${roundId}`)).body;
      for (const a of view.you.allowances) {
        const hash = await walletClient(w).writeContract({ address: a.token, abi: erc20Abi, functionName: "approve", args: [view.round.settlementContract, a.amountRaw], account: w.account, chain: bscChain(anvil.rpcUrl) });
        await rpc.waitForTransactionReceipt({ hash });
      }
    }
    const view = (await wallets[0]!.get(`/api/rounds/${roundId}`)).body;
    expect(view.round.state).toBe("READY_TO_SETTLE");
    expect(view.round.settlementContract).toBe(env().settlementContract);
    expect(view.you.allowances.every((a: { sufficient: boolean }) => a.sufficient)).toBe(true);
  }, 120_000);

  it("one participant settles atomically; the verifier passes from chain data alone", async () => {
    const before = await Promise.all(wallets.map((w) => Promise.all([NVDAB, SPYB, AAPLB].map((a) => rpc.readContract({ address: a.contractAddress, abi: erc20Abi, functionName: "balanceOf", args: [w.address] })))));
    const { body: call } = await wallets[0]!.get(`/api/rounds/${roundId}/settle`);
    const hash = await walletClient(wallets[0]!).sendTransaction({ to: call.to, data: call.data as Hex, account: wallets[0]!.account, chain: bscChain(anvil.rpcUrl) });
    expect((await rpc.waitForTransactionReceipt({ hash })).status).toBe("success");
    const settled = await wallets[0]!.post(`/api/rounds/${roundId}/settle`, { txHash: hash });
    expect(settled.body.state).toBe("COMPLETE");

    const view = (await wallets[1]!.get(`/api/rounds/${roundId}`)).body;
    expect(view.round.verification.status).toBe("PASS");
    const checks = view.round.verification.checks as Array<{ id: string; name: string; status: string }>;
    expect(checks.filter((c) => c.status === "FAIL")).toEqual([]);
    // Same RPC for executor and verifier on a fork: independence is labelled INCONCLUSIVE, never claimed.
    expect(checks.filter((c) => c.status === "INCONCLUSIVE").map((c) => c.id)).toEqual(["providers.independent"]);
    expect(view.round.verification.providers.independent).toBe(false);
    // Every stock was cross-checked against a TWAP (all tier A), and checks carry readable labels.
    expect(checks.find((c) => c.id === "prices.independent")?.status).toBe("PASS");
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(["tx.status", "chain.id", "calldata.plan", "plan.window", "plan.snapshotHash", "balances.netDelta", "balances.noCustody", "participants.set", "event.NonceConsumed"]));
    expect(checks.find((c) => c.id === "event.NonceConsumed")?.name).toMatch(/^Approval used on-chain \((you|member \d)\)$/);
    // Participants are pseudonymized in check names and details.
    for (const w of wallets) expect(JSON.stringify(checks).toLowerCase()).not.toContain(w.address.toLowerCase());

    const after = await Promise.all(wallets.map((w) => Promise.all([NVDAB, SPYB, AAPLB].map((a) => rpc.readContract({ address: a.contractAddress, abi: erc20Abi, functionName: "balanceOf", args: [w.address] })))));
    // A sent NVDAB and got SPYB; B sent SPYB and got AAPLB; C sent AAPLB and got NVDAB.
    expect(after[0]![0]! < before[0]![0]! && after[0]![1]! > before[0]![1]!).toBe(true);
    expect(after[1]![1]! < before[1]![1]! && after[1]![2]! > before[1]![2]!).toBe(true);
    expect(after[2]![2]! < before[2]![2]! && after[2]![0]! > before[2]![0]!).toBe(true);
    const settlementBalances = await Promise.all([NVDAB, SPYB, AAPLB].map((a) => rpc.readContract({ address: a.contractAddress, abi: erc20Abi, functionName: "balanceOf", args: [env().settlementContract] })));
    expect(settlementBalances).toEqual([0n, 0n, 0n]);
  }, 180_000);

  it("publishes the settled round on /proof without exposing participants", async () => {
    const p = await proof();
    expect(p.settlement.address).toBe(env().settlementContract);
    expect(p.rounds).toHaveLength(1);
    expect(p.rounds[0]).toMatchObject({ roundId, circleName: "Fork ring", sequence: 1, state: "COMPLETE", participants: 3, verification: { status: "PASS", pricesIndependent: true, providersIndependent: false } });
    expect(p.rounds[0].cycleCount).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(p).toLowerCase();
    for (const w of wallets) expect(text).not.toContain(w.address.toLowerCase());
  }, 60_000);

  it("leftovers are decided and recorded; activity tells the story", async () => {
    for (const w of wallets) {
      const view = (await w.get(`/api/rounds/${roundId}`)).body;
      if (view.you.residual.length === 0) continue;
      expect((await w.post(`/api/rounds/${roundId}/residual`, { choice: "CARRY_FORWARD", engineDecision: view.you.recommendation?.decision ?? "NONE" })).status).toBe(200);
      expect((await w.get(`/api/rounds/${roundId}`)).body.you.decision.choice).toBe("CARRY_FORWARD");
    }
    const kinds = (await wallets[0]!.get("/api/me/activity")).body.activity.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["SETTLED", "PLAN_APPROVED", "ROUND_MATCHED", "INTENT_SIGNED", "CIRCLE_CREATED", "TARGET_SAVED"]));
    const home = (await wallets[0]!.get("/api/me/home")).body;
    expect(home.circles[0].history[0]).toMatchObject({ state: "COMPLETE" });
    expect(home.target.weights).toEqual({ SPYB: 100 });
    expect(home.pending.every((p: { residualUndecidedUsd: number }) => p.residualUndecidedUsd === 0)).toBe(true);
    expect(kinds).toContain("ROUND_MATCHED");
    expect((await wallets[0]!.get("/api/me/activity")).body.activity.find((a: { kind: string }) => a.kind === "ROUND_MATCHED").detail).toMatchObject({ circle: "Fork ring", sequence: 1 });
  }, 120_000);
});
