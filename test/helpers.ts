import { encodeBigints, reviveBigints } from "@sama/api-types";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { createApp } from "../src/app.ts";

type App = ReturnType<typeof createApp>;

/** Anvil's well-known development keys. Local devnets and forks only. */
export const DEV_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

/** Test process environment: in-memory database, dev login, silent logs, mainnet chain id (forks keep 56). */
export function testEnv(overrides: Record<string, string> = {}) {
  Object.assign(process.env, {
    SAMA_CHAIN_ID: "56",
    SAMA_ENABLE_MAINNET: "1",
    SAMA_PGLITE_DIR: "memory://",
    SAMA_DEV_AUTH: "1",
    SAMA_LOG: "silent",
    SESSION_SECRET: "test-session-secret-test-session-secret",
    SAMA_ALLOWED_ORIGINS: "http://localhost:3200",
    NODE_ENV: "test",
    ...overrides,
  });
}

/** One signed-in wallet talking to the app in-process, with its own cookie jar. */
export class Client {
  cookie = "";
  readonly account: PrivateKeyAccount;

  constructor(
    private readonly app: App,
    key: `0x${string}`,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.account = privateKeyToAccount(key);
  }

  get address() {
    return this.account.address;
  }

  async login() {
    const message = `Sama dev login ${this.address} ${this.nowSec()}`;
    const signature = await this.account.signMessage({ message });
    const r = await this.call("POST", "/api/session/dev", { address: this.address, message, signature });
    if (r.status !== 200) throw new Error(`dev login failed: ${JSON.stringify(r.body)}`);
    return this;
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const response = await this.app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}), origin: "http://localhost:3200" },
        ...(body === undefined ? {} : { body: encodeBigints(body) }),
      }),
    );
    const set = response.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0] as string;
    const text = await response.text();
    return { status: response.status, body: reviveBigints<T>(text ? JSON.parse(text) : null) };
  }

  get = <T = any>(path: string) => this.call<T>("GET", path);
  post = <T = any>(path: string, body: unknown = {}) => this.call<T>("POST", path, body);
}
