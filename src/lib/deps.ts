import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { bscRegistry, type AssetRegistry } from "@sama/assets";
import { BinanceWeb3Client, fetchRwaPrices, fetchRwaTokens, type RwaPrice, type RwaStatus } from "@sama/binance";
import { GeckoTerminalClient } from "@sama/market";
import { bscChain } from "@sama/shared";
import { env } from "./env.ts";
import { providerHost } from "./log.ts";
import { WBNB_ADDRESS, withBnbPrice } from "./spot.ts";
import { verifyPrivyAccessToken, type PrivyIdentity } from "./privy.ts";

export type Providers = { executor: string; verifier: string; independent: boolean; fallbackReason?: string };

/**
 * Everything the server reads from the outside world, behind one seam so tests can run the whole API against an Anvil
 * fork, a fake price feed and a fake identity provider without touching production services.
 */
export type Deps = {
  client: () => PublicClient;
  verifierClient: () => { client: PublicClient; providers: Providers };
  registry: () => AssetRegistry;
  /** Binance prices keyed by lowercase address. Uncached: round snapshots must read fresh prices. */
  fetchPrices: (addresses: readonly string[]) => Promise<Map<string, RwaPrice>>;
  /** Binance trading status keyed by lowercase address (incomplete list; only blocking codes matter). */
  fetchStatus: () => Promise<Map<string, { statusInfo: RwaStatus }>>;
  verifyPrivy: (token: string, address: string) => Promise<PrivyIdentity>;
  /** Token charts, size and trades from on-chain pools. One shared client, so its cache serves every request. */
  market: () => GeckoTerminalClient;
  nowSec: () => number;
};

let binance: BinanceWeb3Client | undefined;
let geckoterminal: GeckoTerminalClient | undefined;

function binanceClient(): BinanceWeb3Client {
  const e = env();
  if (!e.binanceKey || !e.binanceSecret) throw new Error("BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET are not configured");
  binance ??= new BinanceWeb3Client({ apiKey: e.binanceKey, apiSecret: e.binanceSecret }, e.binanceBaseUrl ? { baseUrl: e.binanceBaseUrl } : {});
  return binance;
}

function defaults(): Deps {
  return {
    client: () => createPublicClient({ chain: bscChain(env().rpcUrl), transport: http(env().rpcUrl) }) as PublicClient,
    verifierClient: () => {
      const e = env();
      const executor = providerHost(e.rpcUrl);
      const verifier = providerHost(e.verifierRpcUrl);
      return { client: createPublicClient({ chain: bscChain(e.verifierRpcUrl), transport: http(e.verifierRpcUrl) }) as PublicClient, providers: { executor, verifier, independent: executor !== verifier } };
    },
    registry: () => bscRegistry(),
    fetchPrices: async (addresses) => withBnbPrice(await fetchRwaPrices(binanceClient(), env().chainId, addresses.filter((a) => a.toLowerCase() !== WBNB_ADDRESS)), addresses),
    fetchStatus: () => fetchRwaTokens(binanceClient(), env().chainId),
    verifyPrivy: (token, address) => verifyPrivyAccessToken(token, address),
    market: () => (geckoterminal ??= new GeckoTerminalClient()),
    nowSec: () => Math.floor(Date.now() / 1000),
  };
}

let current: Deps = defaults();

export function deps(): Deps {
  return current;
}

/** Tests replace individual dependencies; call resetDeps() afterwards. */
export function setDeps(patch: Partial<Deps>) {
  current = { ...current, ...patch };
}

export function resetDeps() {
  current = defaults();
  binance = undefined;
}
