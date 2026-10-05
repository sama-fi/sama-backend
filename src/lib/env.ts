import { getAddress, type Address } from "viem";
import { BSC_PUBLIC_RPC, deployment, samaChainId } from "@sama/shared";

/**
 * Configuration comes only from the process environment (Bun loads .env automatically in development). Secrets are read
 * here and never logged; log.ts redacts any field that looks like one.
 */
function read() {
  const e = process.env;
  const chainId = samaChainId(e);
  const production = e.NODE_ENV === "production";
  const settlement = e.SAMA_SETTLEMENT_ADDRESS ? getAddress(e.SAMA_SETTLEMENT_ADDRESS) : deployment(chainId).settlement;
  return {
    chainId,
    production,
    port: Number(e.PORT ?? 3300),
    rpcUrl: e.BSC_RPC_URL || BSC_PUBLIC_RPC,
    /** Optional wss:// endpoint for realtime transfer logs. Polling runs regardless, so a dropped socket loses nothing. */
    wsUrl: e.BSC_WS_URL || undefined,
    /** A different provider than rpcUrl, so verification is independent of the executor's view of the chain. */
    verifierRpcUrl: e.VERIFIER_RPC_URL || "https://bsc-rpc.publicnode.com",
    settlementContract: settlement as Address,
    /** postgres://… for a real server; empty means embedded PGlite in .sama-db (or memory:// in tests). */
    databaseUrl: e.DATABASE_URL || undefined,
    pgliteDir: e.SAMA_PGLITE_DIR || ".sama-db",
    sessionSecret: e.SESSION_SECRET || undefined,
    privyAppId: e.PRIVY_APP_ID || e.NEXT_PUBLIC_PRIVY_APP_ID || undefined,
    privyAppSecret: e.PRIVY_APP_SECRET || undefined,
    binanceKey: e.BINANCE_WEB3_API_KEY || undefined,
    binanceSecret: e.BINANCE_WEB3_API_SECRET || undefined,
    binanceBaseUrl: e.BINANCE_WEB3_BASE_URL || undefined,
    allowedOrigins: (e.SAMA_ALLOWED_ORIGINS ?? "http://localhost:3200").split(",").map((s) => s.trim()).filter(Boolean),
    appOrigin: e.SAMA_APP_ORIGIN || "http://localhost:3200",
    /** Plans whose crossed value exceeds this (USD) are refused while the contract is unaudited. */
    maxPlanUsd: Number(e.SAMA_MAX_PLAN_USD ?? 500),
    swapSlippageBps: Number(e.SAMA_SWAP_SLIPPAGE_BPS ?? 50),
    devAuth: e.SAMA_DEV_AUTH === "1" && !production,
    /** Cross-site cookie (frontend and API on different sites) needs SameSite=None; Partitioned. */
    crossSiteCookie: e.SAMA_CROSS_SITE_COOKIE === "1",
    agentProvider: e.GROQ_API_KEY ? ("GROQ" as const) : e.ANTHROPIC_API_KEY ? ("ANTHROPIC" as const) : null,
    cronIntervalSec: Number(e.SAMA_CRON_INTERVAL_SEC ?? 60),
  };
}

export type Env = ReturnType<typeof read>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= read();
  return cached;
}

/** Tests change process.env between cases; this drops the cached view. */
export function resetEnv() {
  cached = undefined;
}
