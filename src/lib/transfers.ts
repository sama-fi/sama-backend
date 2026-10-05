import { bscChain } from "@sama/shared";
import { createPublicClient, formatUnits, numberToHex, pad, parseAbiItem, toEventSelector, webSocket, type Hex, type Log, type PublicClient } from "viem";
import { db } from "./db/client.ts";
import { deps } from "./deps.ts";
import { env } from "./env.ts";
import { log } from "./log.ts";
import { listedToken } from "./token-list.ts";
import { key, logActivity } from "./users.ts";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

type ScanContext = {
  users: Set<string>;
  settlements: Set<string>;
  registry: Map<string, TokenMeta>;
  client: PublicClient;
  blockTime: (n: bigint) => Promise<Date>;
};

let liveContext: ScanContext | undefined;
let liveClient: PublicClient | undefined;
const subscriptions = new Map<string, Array<() => void>>();

/**
 * Realtime path: one eth_subscribe per user and direction, so a transfer reaches the activity list in seconds. The
 * polling job keeps running, which catches anything a dropped socket missed and makes the two paths agree (dedupe).
 */
function reconcileRealtime(ctx: ScanContext) {
  const { wsUrl, rpcUrl } = env();
  if (!wsUrl) return;
  liveContext = ctx;
  liveClient ??= createPublicClient({ chain: bscChain(rpcUrl), transport: webSocket(wsUrl, { reconnect: true }) }) as PublicClient;

  const onLogs = async (logs: unknown[]) => {
    const c = liveContext;
    if (!c) return;
    for (const l of logs as Log[]) {
      await record(l, c.users, c.settlements, c.registry, c.client, c.blockTime).catch((error: Error) =>
        log("transfers.live_failed", { error: error.message.split("\n")[0] }, "error"),
      );
    }
  };
  const onError = (error: Error) => log("transfers.ws_error", { error: error.message.split("\n")[0] }, "error");

  for (const user of ctx.users) {
    if (subscriptions.has(user)) continue;
    const stops = [
      liveClient.watchEvent({ event: TRANSFER_EVENT, args: { to: user as Hex }, onLogs, onError }),
      liveClient.watchEvent({ event: TRANSFER_EVENT, args: { from: user as Hex }, onLogs, onError }),
    ];
    subscriptions.set(user, stops);
  }
  for (const [user, stops] of subscriptions) {
    if (ctx.users.has(user)) continue;
    stops.forEach((stop) => stop());
    subscriptions.delete(user);
  }
}

/**
 * Finds ERC-20 transfers into and out of every Sama user, from any token, by scanning Transfer logs on BSC. Each log is
 * stored once (tx hash + log index). Settlement transfers are skipped for activity because SETTLED already covers them.
 * Polling, not a socket: the chain has no push to a server, and the UI only needs the list refreshed.
 */
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const CHUNK = 500n;
const MIN_CHUNK = 10n;
const FIRST_SCAN_BLOCKS = 300n;

const ERC20_META = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

type TokenMeta = { symbol: string; decimals: number | null; logo: string };
const metaCache = new Map<string, TokenMeta>();
const addressOf = (topic: Hex) => `0x${topic.slice(26)}`.toLowerCase();

/** Registry tokens are known by symbol and decimals; any other token is read once from the chain and cached. */
async function tokenMeta(token: string, registry: Map<string, TokenMeta>, client: PublicClient): Promise<TokenMeta> {
  const known = registry.get(token);
  if (known) return known;
  const cached = metaCache.get(token);
  if (cached) return cached;
  // PancakeSwap's list names and logos the tokens people hold; its symbol is curated, unlike the one on the contract.
  const listed = await listedToken(token);
  if (listed) {
    const meta: TokenMeta = { symbol: listed.symbol, decimals: listed.decimals, logo: listed.logoURI };
    metaCache.set(token, meta);
    return meta;
  }
  const read = async <T>(functionName: "symbol" | "decimals") => {
    try {
      return (await client.readContract({ address: token as Hex, abi: ERC20_META, functionName })) as T;
    } catch {
      return undefined;
    }
  };
  // Symbols on tokens outside the registry are set by whoever deployed them, so they are never shown as a name.
  // Decimals still come from the chain so the amount reads correctly; the token address stays in the activity detail.
  const meta: TokenMeta = { symbol: "UNKNOWN", decimals: (await read<number>("decimals")) ?? null, logo: "" };
  metaCache.set(token, meta);
  return meta;
}

export async function syncTransfers(): Promise<{ scannedTo: string; recorded: number }> {
  const d = deps();
  const client = d.client();
  const latest = await client.getBlockNumber();
  const database = await db();
  const cursor = await database.query<{ block: string | number }>("select block from chain_cursor where name = 'transfers'");
  let from = cursor[0] ? BigInt(cursor[0].block) + 1n : latest > FIRST_SCAN_BLOCKS ? latest - FIRST_SCAN_BLOCKS : 0n;

  const users = new Set((await database.query<{ address: string }>("select address from users")).map((r) => key(r.address)));
  const settlements = new Set((await database.query<{ tx: string }>("select settlement_tx as tx from rounds where settlement_tx is not null")).map((r) => r.tx.toLowerCase()));
  const registry = new Map<string, TokenMeta>();
  for (const a of [d.registry().cash(), ...d.registry().stocks()]) registry.set(a.contractAddress.toLowerCase(), { symbol: a.symbol, decimals: a.decimals, logo: "" });

  const blockTimes = new Map<bigint, Date>();
  const blockTime = async (n: bigint) => {
    const hit = blockTimes.get(n);
    if (hit) return hit;
    const time = new Date(Number((await client.getBlock({ blockNumber: n })).timestamp) * 1000);
    blockTimes.set(n, time);
    return time;
  };

  let recorded = 0;
  reconcileRealtime({ users, settlements, registry, client, blockTime });

  // RPC providers cap how many blocks one eth_getLogs may span. Start at CHUNK and halve on that error, down to MIN_CHUNK.
  let chunk = CHUNK;
  while (from <= latest && users.size > 0) {
    const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
    try {
      for (const user of users) {
        const topic = pad(user as Hex, { size: 32 });
        const filters = [
          [TRANSFER_TOPIC, null, topic],
          [TRANSFER_TOPIC, topic],
        ] as const;
        for (const topics of filters) {
          const logs = await getRawLogs(client, from, to, topics as unknown as (Hex | null)[]);
          for (const l of logs) {
            recorded += await record(l, users, settlements, registry, client, blockTime);
          }
        }
      }
    } catch (error) {
      if (chunk > MIN_CHUNK && /exceed|limit|range|too many/i.test((error as Error).message)) {
        chunk = chunk / 2n;
        continue;
      }
      throw error;
    }
    await database.query("insert into chain_cursor (name, block) values ('transfers', $1) on conflict (name) do update set block = excluded.block", [to.toString()]);
    from = to + 1n;
  }
  if (recorded > 0) log("transfers.recorded", { recorded, scannedTo: latest.toString() });
  return { scannedTo: latest.toString(), recorded };
}

/** viem's getLogs has no topic filter with wildcards, so this calls eth_getLogs and converts the hex fields. */
async function getRawLogs(client: PublicClient, from: bigint, to: bigint, topics: (Hex | null)[]): Promise<Log[]> {
  const raw = await client.request({ method: "eth_getLogs", params: [{ fromBlock: numberToHex(from), toBlock: numberToHex(to), topics }] });
  return (raw as Array<{ address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex }>).map((l) => ({
    address: l.address,
    topics: l.topics as [Hex, ...Hex[]],
    data: l.data,
    blockNumber: BigInt(l.blockNumber),
    transactionHash: l.transactionHash,
    logIndex: Number(BigInt(l.logIndex)),
  })) as unknown as Log[];
}

async function record(
  l: Log,
  users: Set<string>,
  settlements: Set<string>,
  registry: Map<string, TokenMeta>,
  client: PublicClient,
  blockTime: (n: bigint) => Promise<Date>,
): Promise<number> {
  if (!l.transactionHash || l.logIndex == null || l.blockNumber == null || l.topics.length < 3) return 0;
  const tx = l.transactionHash.toLowerCase();
  const token = l.address.toLowerCase();
  const from = addressOf(l.topics[1] as Hex);
  const to = addressOf(l.topics[2] as Hex);
  const amount = BigInt(l.data);
  const inserted = await (await db()).query<{ tx_hash: string }>(
    "insert into transfers (tx_hash, log_index, token, from_addr, to_addr, amount_raw, block_number, block_time) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing returning tx_hash",
    [tx, Number(l.logIndex), token, from, to, amount.toString(), l.blockNumber.toString(), await blockTime(l.blockNumber)],
  );
  if (inserted.length === 0 || settlements.has(tx)) return inserted.length;

  const meta = await tokenMeta(token, registry, client);
  const detail = { symbol: meta.symbol, amount: meta.decimals === null ? amount.toString() : formatUnits(amount, meta.decimals), token, tx, logo: meta.logo };
  if (users.has(to)) await logActivity(to, "TRANSFER_IN", { ...detail, counterparty: from });
  if (users.has(from)) await logActivity(from, "TRANSFER_OUT", { ...detail, counterparty: to });
  return 1;
}
