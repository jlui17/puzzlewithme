import type { IncomingMessage } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { InMemoryRoomStore } from "../store/room-store.js";
import { AuthenticationError, authenticatorFromEnv, cloudflareAuthenticator, normalizeEmail } from "./identity.js";

const issuer = "https://test.cloudflareaccess.com";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let authenticate: ReturnType<typeof cloudflareAuthenticator>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  authenticate = cloudflareAuthenticator(new InMemoryRoomStore(), issuer, "puzzle", createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }));
});
function request(token?: string): IncomingMessage {
  return { headers: token ? { "cf-access-jwt-assertion": token } : {} } as IncomingMessage;
}
async function token(overrides: Record<string, unknown> = {}, key = keys.privateKey) {
  return new SignJWT({ email: "Person@example.com", iss: issuer, aud: ["puzzle"], sub: "person", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, ...overrides })
    .setProtectedHeader({ alg: "RS256" }).sign(key);
}
describe("Cloudflare identity", () => {
  it("resolves independent assertions for one email to one private account", async () => {
    const first = await authenticate(request(await token()));
    const second = await authenticate(request(await token({ sub: "new-provider-subject", email: "person@example.com" })));
    expect(first.userId).toBe(second.userId);
    expect(first.email).toBe("person@example.com");
  });
  it.each([
    ["expired", { exp: 1 }], ["issuer", { iss: "https://wrong.cloudflareaccess.com" }],
    ["audience", { aud: ["other-app"] }], ["missing expiry", { exp: undefined }],
    ["missing email", { email: undefined }], ["invalid email", { email: "invalid" }],
    ["future", { nbf: Math.floor(Date.now() / 1000) + 300 }],
  ])("rejects %s claims", async (_, overrides) => {
    await expect(authenticate(request(await token(overrides)))).rejects.toBeInstanceOf(AuthenticationError);
  });
  it("rejects missing and forged assertions", async () => {
    await expect(authenticate(request())).rejects.toBeInstanceOf(AuthenticationError);
    const attacker = await generateKeyPair("RS256");
    await expect(authenticate(request(await token({}, attacker.privateKey)))).rejects.toBeInstanceOf(AuthenticationError);
    await expect(authenticate(request("not.a.jwt"))).rejects.toBeInstanceOf(AuthenticationError);
  });
  it("requires explicit configuration and forbids development auth in production", async () => {
    const store = new InMemoryRoomStore();
    expect(() => authenticatorFromEnv(store, {})).toThrow();
    expect(() => authenticatorFromEnv(store, { AUTH_MODE: "development", DEV_USER_EMAIL: "a@b.test", NODE_ENV: "production" })).toThrow();
    const dev = authenticatorFromEnv(store, { AUTH_MODE: "development", DEV_USER_EMAIL: "a@b.test" });
    expect((await dev(request())).email).toBe("a@b.test");
  });
  it("does not merge plus-addresses or dots", () => {
    expect(normalizeEmail(" A.B+tag@Example.com ")).toBe("a.b+tag@example.com");
  });
});
