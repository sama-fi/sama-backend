import { createRemoteJWKSet, jwtVerify } from "jose";
import { getAddress, isAddress, type Address } from "viem";
import { env } from "./env.ts";
import { AuthError } from "./errors.ts";

export type PrivyIdentity = { address: Address; privyUserId: string; walletKind: "embedded" | "external"; email: string | null };

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
const userCache = new Map<string, { at: number; accounts: LinkedAccount[]; email: string | null }>();
const USER_TTL_MS = 5 * 60_000;

type LinkedAccount = { type: string; address?: string; chain_type?: string; wallet_client_type?: string; connector_type?: string; email?: string };

/**
 * Verifies a Privy access token (ES256, the app's JWKS, issuer privy.io, audience = app id), then proves `address`
 * belongs to that Privy user by reading the user's linked wallets with the app secret. A client cannot claim a wallet
 * Privy has not linked to the signed-in user.
 */
export async function verifyPrivyAccessToken(token: string, address: string): Promise<PrivyIdentity> {
  const { privyAppId, privyAppSecret } = env();
  if (!privyAppId || !privyAppSecret) throw new AuthError("Privy is not configured on this server (PRIVY_APP_ID, PRIVY_APP_SECRET).");
  if (!isAddress(address, { strict: false })) throw new AuthError("No EVM wallet on this session.");
  jwks ??= createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${privyAppId}/jwks.json`));
  let sub: string;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: "privy.io", audience: privyAppId, algorithms: ["ES256"] });
    if (!payload.sub) throw new Error("no subject");
    sub = payload.sub;
  } catch (error) {
    throw new AuthError(`Privy session could not be verified: ${(error as Error).message}`);
  }

  const user = await privyUser(sub, privyAppId, privyAppSecret);
  const wallet = user.accounts.find((a) => a.type === "wallet" && (a.chain_type === undefined || a.chain_type === "ethereum") && a.address?.toLowerCase() === address.toLowerCase());
  if (!wallet) throw new AuthError("That wallet is not linked to this Privy account.");
  return { address: getAddress(address), privyUserId: sub, walletKind: wallet.wallet_client_type === "privy" || wallet.connector_type === "embedded" ? "embedded" : "external", email: user.email };
}

async function privyUser(did: string, appId: string, secret: string) {
  const cached = userCache.get(did);
  if (cached && Date.now() - cached.at < USER_TTL_MS) return cached;
  const response = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(did)}`, {
    headers: { authorization: `Basic ${btoa(`${appId}:${secret}`)}`, "privy-app-id": appId },
  });
  if (!response.ok) throw new AuthError(`Privy user lookup failed (HTTP ${response.status}).`);
  const body = (await response.json()) as { linked_accounts?: LinkedAccount[] };
  const accounts = body.linked_accounts ?? [];
  const entry = { at: Date.now(), accounts, email: accounts.find((a) => a.type === "email")?.address ?? null };
  userCache.set(did, entry);
  return entry;
}
