import { createApp } from "./app.ts";
import { db } from "./lib/db/client.ts";
import { env } from "./lib/env.ts";
import { log } from "./lib/log.ts";
import { advanceActiveRounds } from "./lib/rounds.ts";

const e = env();
await db();
const app = createApp().listen(e.port);
log("server.started", { port: e.port, chainId: e.chainId, settlement: e.settlementContract, origins: e.allowedOrigins, binance: Boolean(e.binanceKey), privy: Boolean(e.privyAppId && e.privyAppSecret), devAuth: e.devAuth });

/** Rounds also advance on every read; this loop covers rounds nobody is looking at (freeze, expire, resume). */
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await advanceActiveRounds();
  } catch (error) {
    log("cron.failed", { error: (error as Error).message.split("\n")[0] }, "error");
  } finally {
    running = false;
  }
}, e.cronIntervalSec * 1000);

export type App = typeof app;
