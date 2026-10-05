import { BinanceApiError } from "@sama/binance";
import { PancakeQuoteError } from "@sama/pancakeswap";
import { log } from "./log.ts";

/** No valid session cookie, or the Privy token could not be verified. 401. */
export class AuthError extends Error {}
/** Bad input from the client. 400. */
export class InputError extends Error {}
/** The thing does not exist or the viewer may not see it. 404. */
export class NotFoundError extends Error {}
/** A round rule refused the action (wrong state, window closed, not a member). 409. */
export class RoundError extends Error {}
/** A circle rule refused the action. 409. */
export class CircleError extends Error {}

/** Failures with a known cause get a specific status and a message the user can act on. */
export function classify(error: unknown): { status: number; message: string } | undefined {
  if (error instanceof AuthError) return { status: 401, message: error.message };
  if (error instanceof InputError) return { status: 400, message: error.message };
  if (error instanceof NotFoundError) return { status: 404, message: error.message };
  if (error instanceof RoundError || error instanceof CircleError) return { status: 409, message: error.message };
  if (error instanceof PancakeQuoteError) return { status: 502, message: `PancakeSwap: ${error.message}.` };
  if (error instanceof BinanceApiError) {
    log("dependency.down", { dependency: "binance", status: error.status, code: error.code }, "error");
    return { status: 503, message: "Binance prices are not available right now. Try again shortly." };
  }
  const e = error as { name?: string; code?: string; message?: string };
  const message = e.message ?? "";
  if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "CONNECTION_ENDED" || e.code === "CONNECTION_CLOSED" || e.code === "57P01" || /database|postgres|PGlite/i.test(message)) {
    log("dependency.down", { dependency: "database", code: e.code, error: message.split("\n")[0] }, "error");
    return { status: 503, message: "Sama lost its database connection while handling this. Check the page before retrying; the step may not have completed." };
  }
  if (e.name === "HttpRequestError" || e.name === "TimeoutError" || e.name === "RpcRequestError" || /HTTP request failed|fetch failed/i.test(message)) {
    log("dependency.down", { dependency: "rpc", error: message.split("\n")[0] }, "error");
    return { status: 503, message: "BNB Chain's RPC is not responding right now. Try again shortly." };
  }
  return undefined;
}
