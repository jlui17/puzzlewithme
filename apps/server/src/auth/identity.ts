import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { RoomStore } from "../store/room-store.js";

export interface Account {
  userId: string;
  email: string;
  displayName: string;
}
export interface Principal extends Account { expiresAt?: number }
export type Authenticator = (req: IncomingMessage) => Promise<Principal>;
export class AuthenticationError extends Error {}
export const rejectAuthentication: Authenticator = async () => { throw new AuthenticationError(); };

/** App policy: case-insensitive emails, preserving dots and +tags. */
export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(normalized)) {
    throw new AuthenticationError("Invalid email");
  }
  return normalized;
}

export function cloudflareAuthenticator(
  store: RoomStore,
  issuer: string,
  audience: string,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
): Authenticator {
  return async (req) => {
    const token = req.headers["cf-access-jwt-assertion"];
    if (typeof token !== "string") throw new AuthenticationError();
    let email: string;
    let expiresAt: number;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer, audience, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "email"],
      });
      if (typeof payload["email"] !== "string") throw new AuthenticationError();
      email = normalizeEmail(payload["email"]);
      expiresAt = payload.exp! * 1000;
    } catch {
      // Never log assertions or token payloads.
      throw new AuthenticationError();
    }
    return { ...await store.findOrCreateAccount(email), expiresAt };
  };
}

/** No implicit anonymous mode. The executable always requires explicit identity configuration. */
export function authenticatorFromEnv(store: RoomStore, env: NodeJS.ProcessEnv): Authenticator {
  if (env["AUTH_MODE"] === "development") {
    if (env["NODE_ENV"] === "production") throw new Error("Development authentication is forbidden in production");
    const email = normalizeEmail(env["DEV_USER_EMAIL"] ?? "");
    return async () => store.findOrCreateAccount(email);
  }
  if (env["AUTH_MODE"] !== undefined && env["AUTH_MODE"] !== "cloudflare") throw new Error("Unknown AUTH_MODE");
  const issuer = env["CF_ACCESS_ISSUER"]?.replace(/\/$/, "");
  const audience = env["CF_ACCESS_AUD"];
  if (!issuer || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience?.trim()) {
    throw new Error("Set CF_ACCESS_ISSUER and CF_ACCESS_AUD, or explicitly configure development authentication");
  }
  return cloudflareAuthenticator(store, issuer, audience);
}
