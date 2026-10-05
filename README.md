# sama-backend

Sama API on [Elysia](https://elysiajs.com) and Bun, ported from `venue0-backend` (Next route handlers) to the bStocks
universe on BNB Chain. It serves `sama-frontend` (`NEXT_PUBLIC_SAMA_API_MODE=live`) on port 3300.

```
bun install
cp .env.example .env      # fill PRIVY_*, BINANCE_WEB3_*, SESSION_SECRET
bun run dev               # http://localhost:3300/api/health
bun test                  # offline API tests (fake prices, in-memory PGlite)
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
| `src/lib/deps.ts` | The seam to the outside world (RPC, Binance, Privy, clock); tests replace it |
| `src/lib/rounds.ts` | Round lifecycle: snapshot, intents, matching, plan, approvals, settle, verification |
| `src/lib/residuals.ts` | Leftovers: carry forward, cancel, or swap through PancakeSwap V3 (tier A, NYSE open) |
| `src/lib/views.ts`, `circle-view.ts` | Server state to the frontend's wire types (`@sama/api-types`) |
| `src/lib/market.ts` | Asset list, display prices (Binance, 5 s cache), portfolio via one multicall |
| `src/lib/privy.ts`, `session.ts` | Privy access-token verification and the `sama_session` cookie |
| `src/lib/db` | Schema and the Postgres / PGlite client |

## Routes

Public: `GET /api/health`, `GET /api/assets`, `GET /api/invites/:code`, `POST|GET|DELETE /api/session`,
`POST /api/session/dev` (only with `SAMA_DEV_AUTH=1`, never in production).

Signed in: `GET /api/me/home`, `GET /api/me/portfolio`, `GET /api/me/portfolio/history?range=`,
`GET|POST /api/me/target`, `POST /api/me/target/preview`, `GET|POST /api/me/settings`, `GET /api/me/activity`,
`GET|POST /api/circles`, `GET /api/circles/:id`, `POST /api/circles/:id/{join,invite,round}`, `GET /api/rounds/:id`,
`GET|POST /api/rounds/:id/{intent,approval,settle}`, `POST /api/rounds/:id/{close,residual,residual/swap}`.

Bigints travel as `{"$bigint": "<decimal>"}` in both directions.
