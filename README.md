# Sama Backend

Backend API for Sama, a collaborative portfolio and round-based settlement app for the bStocks universe on BNB Chain. The service is built with [Bun](https://bun.sh/), [Elysia](https://elysiajs.com/), TypeScript, and `viem`.

The API serves the Sama frontend (`sama-frontend`) and coordinates:

- wallet/session authentication;
- bStock and portfolio market data;
- target portfolio validation and AI-assisted suggestions;
- shared circles and invite links;
- signed round intents, approvals, settlement, and residual handling;
- activity, transfer synchronization, saved assistant chats, and onboarding settings.

## Requirements

- Bun 1.x (the repository is tested with Bun; Node.js/npm are not the supported runtime).
- Git.
- The sibling `sama-packages` repository, because the backend imports shared domain and wire types through TypeScript path aliases.
- A BSC RPC endpoint for live chain operations.

For local development, the backend can use embedded PGlite and the public BSC RPC defaults. Privy and Binance credentials are required for the corresponding production integrations.

## Quick start

From the parent `Hackathon` directory:

```bash
cd sama-packages
bun install

cd ../sama-backend
bun install
cp .env.example .env
```

Fill in the required values in `.env`, then start the API:

```bash
bun run dev
```

The server listens on `http://localhost:3300` by default. Verify it with:

```bash
curl http://localhost:3300/api/health
```

The embedded database is created in `.sama-db` when `DATABASE_URL` is empty. It is ignored by Git and is suitable for local development only.

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Start the API with Bun watch mode. |
| `bun start` | Start the API once. |
| `bun test` | Run the offline API test suite. |
| `bun run typecheck` | Run TypeScript checking without emitting files. |
| `bun run db:migrate` | Apply the database migration script. |
| `SAMA_FORK=1 bun test test/e2e.fork.test.ts` | Run the fork-based end-to-end test when Anvil and Binance credentials are available. |

## Configuration

Copy `.env.example` to `.env`. Bun loads `.env` automatically during local development. Never commit `.env` or production secrets.

### Chain and server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3300` | HTTP port. |
| `SAMA_CHAIN_ID` | shared package default | Chain ID; `56` is BNB Chain mainnet. |
| `SAMA_ENABLE_MAINNET` | unset | Must be `1` before enabling mainnet operations. |
| `BSC_RPC_URL` | public BSC RPC | Executor RPC used for reads and transactions. |
| `BSC_WS_URL` | unset | Optional WebSocket endpoint for realtime transfer logs. Polling remains enabled. |
| `VERIFIER_RPC_URL` | `https://bsc-rpc.publicnode.com` | Independent RPC used to verify settlement. |
| `SAMA_SETTLEMENT_ADDRESS` | deployment file | Override the deployed settlement contract address. |
| `SAMA_CRON_INTERVAL_SEC` | `60` | Interval for advancing active rounds. |

### Database and sessions

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL URL. Leave empty to use embedded PGlite. |
| `SAMA_PGLITE_DIR` | PGlite directory; defaults to `.sama-db`. |
| `SESSION_SECRET` | Secret used to sign the `sama_session` cookie. Set this explicitly in production. |
| `SAMA_CROSS_SITE_COOKIE` | Set to `1` when frontend and API are on different sites; enables cross-site cookie attributes. |

### Authentication and integrations

| Variable | Description |
|---|---|
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Privy application credentials for production login. |
| `BINANCE_WEB3_API_KEY` / `BINANCE_WEB3_API_SECRET` | Binance Web3 RWA API credentials for bStock prices and status. |
| `COINGECKO_API_KEY` | Optional CoinGecko Demo key for token history and trade data. |
| `SAMA_DEV_AUTH` | Set to `1` only in non-production environments to enable signed local-wallet login. |
| `SAMA_ALLOWED_ORIGINS` | Comma-separated browser origins allowed by CORS and the mutation origin guard. |
| `SAMA_APP_ORIGIN` | Frontend origin used when generating invite URLs. |

### Safety and assistant settings

| Variable | Description |
|---|---|
| `SAMA_MAX_PLAN_USD` | Maximum plan value accepted while the settlement contract is unaudited; default `500`. |
| `SAMA_SWAP_SLIPPAGE_BPS` | Residual swap slippage in basis points; default `50`. |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | Optional OpenAI-compatible assistant provider. |
| `GROQ_API_KEY` | Optional fallback assistant provider. |
| `ANTHROPIC_API_KEY` | Optional fallback assistant provider after Groq. |

## API

The base URL is `http://localhost:3300`. All JSON responses include `Cache-Control: no-store`; responses also expose an `x-request-id` header for support and log correlation.

### Authentication

Production clients call `POST /api/session` with a Privy access token and wallet address:

```json
{
  "token": "<privy-access-token>",
  "address": "0x..."
}
```

The server verifies the token, upserts the user, and returns a signed `sama_session` cookie. Send that cookie on authenticated requests. `GET /api/session` returns the current user, while `DELETE /api/session` clears the cookie.

For local development only, set `SAMA_DEV_AUTH=1` and use `POST /api/session/dev` with a wallet signature over `Sama dev login <address> <unix seconds>`. The timestamp is accepted for five minutes. This endpoint is disabled automatically when `NODE_ENV=production`.

### Public endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Database, chain, contract, and integration health. Returns `503` when the database is unreachable. |
| `GET` | `/api/assets` | Allowlisted bStocks, WBNB, and USDT assets. |
| `GET` | `/api/proof` | Public proof/deployment data. |
| `GET` | `/api/market/:token` | Token stats for an allowlisted address or symbol. |
| `GET` | `/api/market/:token/history?range=` | Token price history. |
| `GET` | `/api/market/:token/trades` | Latest token trades. |
| `GET` | `/api/invites/:code` | Public invite preview. |
| `GET` | `/api/agent` | Whether the natural-language assistant is enabled. |
| `POST` | `/api/session` | Create a Privy-backed session. |
| `GET` | `/api/session` | Read the current session, if any. |
| `DELETE` | `/api/session` | Clear the current session. |
| `POST` | `/api/session/dev` | Local-only signed wallet login. |

Market routes accept only tokens from Sama's allowlist. A token not found in that list returns `404`. If CoinGecko is unavailable and no cached answer exists, market routes may return `503`.

### Authenticated endpoints

All paths below require a valid `sama_session` cookie.

| Area | Methods and paths |
|---|---|
| Home and portfolio | `GET /api/me/home`, `GET /api/me/portfolio`, `GET /api/me/portfolio/history?range=` |
| Targets | `GET|POST /api/me/target`, `POST /api/me/target/preview`, `POST /api/me/target/suggest` |
| Assistant | `POST /api/me/assistant`, `GET|DELETE /api/me/chats`, `GET|DELETE /api/me/chats/:id` |
| Preferences | `GET|POST /api/me/settings`, `GET|POST /api/me/onboarding` |
| Activity and transfers | `GET /api/me/activity`, `POST /api/me/transfers/sync` |
| Circles | `GET|POST /api/circles`, `GET /api/circles/:id`, `POST /api/circles/:id/join`, `POST /api/circles/:id/invite`, `POST /api/circles/:id/round` |
| Rounds | `GET /api/rounds/:id`, `GET|POST /api/rounds/:id/intent`, `POST /api/rounds/:id/close`, `GET|POST /api/rounds/:id/approval`, `GET|POST /api/rounds/:id/settle` |
| Residuals | `POST /api/rounds/:id/residual`, `POST /api/rounds/:id/residual/swap` |

Round signing is deliberately split into prepare/submit steps: the client obtains an unsigned intent or approval payload, signs it in the wallet, and submits the signature. Settlement follows the same pattern: `GET` returns the wallet call and `POST` records the resulting transaction hash for verification.

The residual swap endpoint uses three request steps: `prepare`, `build`, and `record`.

### Wire format and errors

JavaScript `bigint` values cross the API boundary as objects such as:

```json
{ "$bigint": "1234567890000000000" }
```

The frontend's live client revives this representation back into `bigint` values. Request bodies may use the same format.

Expected validation, authentication, authorization, and round errors return a JSON object with an `error` message and an appropriate `4xx` or `503` status. Unexpected failures return `500` and include a shortened request identifier. Pass an `x-request-id` header to correlate a request with structured server logs; otherwise the server generates one.

## Project layout

| Path | Responsibility |
|---|---|
| `src/app.ts` | Elysia app, routes, CORS, origin protection, request wrapper, and error classification. |
| `src/index.ts` | Server startup plus background round and transfer synchronization loops. |
| `src/lib/deps.ts` | External dependency seam for RPC, Binance, CoinGecko, Privy, and the clock; tests replace these dependencies. |
| `src/lib/rounds.ts` | Round lifecycle: snapshot, intent matching, planning, approvals, settlement, and verification. |
| `src/lib/residuals.ts` | Carry-forward, cancel, and PancakeSwap V3 residual flows. |
| `src/lib/market.ts` / `src/lib/spot.ts` | Asset list, portfolio reads, and BNB/WBNB spot pricing. |
| `src/lib/token-market.ts` | Cached token stats, history, and trades. |
| `src/lib/assistant.ts` / `src/lib/assistant-chats.ts` | Read-only assistant tools, proposals, and saved chats. |
| `src/lib/session.ts` / `src/lib/privy.ts` | Privy verification and signed session cookies. |
| `src/lib/db` | PostgreSQL/PGlite client and schema. |
| `test/` | Offline API tests and the optional BSC fork end-to-end test. |
| `deploy/` / `scripts/` | Semaphore/Ansible deployment and remote restart/health-check scripts. |

Shared domain logic and wire types live in the sibling `sama-packages` repository and are resolved through `tsconfig.json` path aliases. No separate backend build step is required.

## Testing

The default test suite uses an in-memory PGlite database, fake external dependencies, and signed development wallets. It does not require production credentials:

```bash
bun test
bun run typecheck
```

The fork test exercises a complete settlement flow against a BSC mainnet fork. It requires Anvil, a funded fork configuration, and the relevant Binance credentials:

```bash
SAMA_FORK=1 bun test test/e2e.fork.test.ts
```

Do not use the well-known test private keys in `test/helpers.ts` outside local development or an isolated fork.

## Deployment

The repository includes a Semaphore template at `deploy/sama.yml` and the remote deployment script at `scripts/deploy-remote.sh`. The deployment workflow:

1. pulls the latest `sama-packages` and `sama-backend` commits with `git pull --ff-only`;
2. installs dependencies with Bun;
3. restarts `sama-backend.service`;
4. waits for `GET http://127.0.0.1:3300/api/health` to succeed.

The production service reads its environment from `sama-backend/.env` through `systemd`. Deployment does not modify that file. Configure secrets and production origins on the server, then restart the service after changing them.

The deploy script expects the default server layout `$HOME/sama/{sama-packages,sama-backend}` and Bun at `/usr/local/bin/bun`; override `SAMA_DIR` or `BUN` when needed.

## Security notes

- Never commit `.env`, private keys, API secrets, or production database credentials.
- Keep `SAMA_DEV_AUTH` disabled in production; it is also forced off when `NODE_ENV=production`.
- Use separate executor and verifier RPC providers where possible.
- Keep `SAMA_MAX_PLAN_USD` conservative until the settlement contract is audited.
- Configure exact frontend origins in `SAMA_ALLOWED_ORIGINS`; the backend rejects state-changing requests from unapproved origins.
- Treat settlement and residual transactions as wallet actions: the backend prepares and verifies them, while the user's wallet signs and submits them.

## License

No license file is currently included. Add the project's license before distributing the backend outside the team.
