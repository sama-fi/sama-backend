# sama-backend

Sama API on [Elysia](https://elysiajs.com) and Bun, for the bStocks
universe on BNB Chain (88 bStocks, WBNB and USDT). It serves `sama-frontend` (`NEXT_PUBLIC_SAMA_API_MODE=live`) on port 3300.

```
bun install
cp .env.example .env      # fill PRIVY_*, BINANCE_WEB3_*, SESSION_SECRET; COINGECKO_API_KEY and AI_* are optional
bun run dev               # http://localhost:3300/api/health
bun test                  # offline API tests (fake prices, fake market data, in-memory PGlite)
SAMA_FORK=1 bun test test/e2e.fork.test.ts   # full round on a BSC mainnet fork (needs anvil + Binance keys)
bun run typecheck
```

Domain logic lives in `../sama-packages` and is imported as `@sama/*` through `tsconfig.json` `paths` (no build step).
Run `bun install` in `../sama-packages` first.

## Layout

| Path | What |
|---|---|
| `src/app.ts` | Every route, the request wrapper (request id, session, error classification), CORS and the foreign-origin guard |
| `src/index.ts` | Starts the server and the background loop that advances rounds nobody is reading |
| `src/lib/deps.ts` | The seam to the outside world (RPC, Binance, CoinGecko, Privy, clock); tests replace it |
| `src/lib/rounds.ts` | Round lifecycle: snapshot, intents, matching, plan, approvals, settle, verification |
| `src/lib/residuals.ts` | Leftovers: carry forward, cancel, or swap through PancakeSwap V3 (tier A, NYSE open) |
| `src/lib/views.ts`, `circle-view.ts` | Server state to the frontend's wire types (`@sama/api-types`) |
| `src/lib/market.ts` | Asset list, display prices (Binance, 5 s cache), portfolio via one multicall |
| `src/lib/spot.ts` | BNB's spot price (Binance ticker), used for the wallet's BNB and as WBNB's price in round snapshots |
| `src/lib/token-market.ts` | Token pages: stats, price history and latest trades for allowlisted tokens, through `@sama/market` |
| `src/lib/assistant.ts`, `assistant-chats.ts` | The AI assistant (read-only tools plus proposals the user confirms) and its saved chats |
| `src/lib/privy.ts`, `session.ts` | Privy access-token verification and the `sama_session` cookie |
| `src/lib/db` | Schema and the Postgres / PGlite client |

## Routes

Public: `GET /api/health`, `GET /api/assets`, `GET /api/proof`, `GET /api/invites/:code`, `GET /api/agent`,
`GET /api/market/:token`, `GET /api/market/:token/history?range=`, `GET /api/market/:token/trades`,
`POST|GET|DELETE /api/session`, `POST /api/session/dev` (only with `SAMA_DEV_AUTH=1`, never in production).

Signed in: `GET /api/me/home`, `GET /api/me/portfolio`, `GET /api/me/portfolio/history?range=`,
`GET|POST /api/me/target`, `POST /api/me/target/{preview,suggest}`, `POST /api/me/assistant`,
`GET|DELETE /api/me/chats`, `GET|DELETE /api/me/chats/:id`, `GET|POST /api/me/settings`, `GET|POST /api/me/onboarding`,
`GET /api/me/activity`, `POST /api/me/transfers/sync`,
`GET|POST /api/circles`, `GET /api/circles/:id`, `POST /api/circles/:id/{join,invite,round}`, `GET /api/rounds/:id`,
`GET|POST /api/rounds/:id/{intent,approval,settle}`, `POST /api/rounds/:id/{close,residual,residual/swap}`.

`/api/market/*` takes an address or a symbol and serves allowlisted tokens only (anything else is a 404). Answers are
cached and shared by every caller; when CoinGecko is down and nothing is cached it answers 503.

Bigints travel as `{"$bigint": "<decimal>"}` in both directions.

## Deploy

The Semaphore template "Deploy Sama BE" runs `deploy/sama.yml`, which runs `scripts/deploy-remote.sh` on the server:
pull `sama-packages` and `sama-backend`, `bun install` in both, restart `sama-backend.service`, and wait for
`/api/health`. Running the script over ssh does the same thing.

- The service reads its environment from `sama-backend/.env` on the server (`EnvironmentFile=` in the unit). A deploy
  does not change it: add or edit variables there, then restart the service.
- `bun install` on the server can rewrite `bun.lock`. The script discards that before each pull, so the next
  `git pull --ff-only` does not refuse an upstream lockfile change.
- Set `COINGECKO_API_KEY` in production. Without it token pages use GeckoTerminal's free limit, which is counted per IP
  address and is easily reached from a shared server address.
