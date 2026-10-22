import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers } from "@paperclipai/db";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import { startTestDb, type TestDb } from "./helpers/test-db.js";

// Railway incident A5: the production image must close sign-up on every path
// (email/password, Google redirect, Google id token) while an existing owner
// can still sign in, the documented override must reopen it, and Better Auth
// must refuse to start without a secret. The policy is read the way production
// reads it: the PAPERCLIP_* ENV of Dockerfile.railway through loadConfig().
// Real Better Auth over a real PostgreSQL; only Google's two HTTPS endpoints
// (token exchange, JWKS) are faked, with a local RSA key.

const ORIGIN = "http://localhost:3100";
const CLIENT_ID = "FAKE_TEST_GOOGLE_CLIENT_ID";
const KID = "fake-test-kid";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

type Auth = ReturnType<typeof createBetterAuthInstance>;
let testDb: TestDb;
let loadConfig: () => Config;
let productionConfig: Config;
let recoveryConfig: Config;
let openAuth: Auth;
let closedAuth: Auth;
let googleUser = { email: "", sub: "" };

// KEY=VALUE pairs of every ENV instruction in Dockerfile.railway.
function dockerfileRailwayEnv() {
  const text = readFileSync(new URL("../../../Dockerfile.railway", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of text.replace(/\r/g, "").replace(/\\\n/g, " ").split("\n")) {
    if (!line.startsWith("ENV ")) continue;
    for (const m of line.slice(4).matchAll(/([A-Za-z0-9_]+)=(\S+)/g)) env[m[1]] = m[2];
  }
  return env;
}

// Config as the Railway image builds it. Only PAPERCLIP_* variables are
// applied (NODE_ENV/HOME would change the test process); home and config
// file point at an empty temp dir, and env beats the config file anyway.
function configFromEnv(env: Record<string, string>, overrides: Record<string, string | undefined> = {}) {
  const home = mkdtempSync(join(tmpdir(), "paperclip-a5-home-"));
  const vars = { ...env, PAPERCLIP_HOME: home, PAPERCLIP_CONFIG: join(home, "config.json"), ...overrides };
  for (const [name, value] of Object.entries(vars)) {
    if (name.startsWith("PAPERCLIP_")) vi.stubEnv(name, value);
  }
  try {
    return loadConfig();
  } finally {
    for (const name of Object.keys(vars)) if (name.startsWith("PAPERCLIP_")) vi.stubEnv(name, undefined);
  }
}

function b64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function googleIdToken(email: string, sub: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = b64url({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub,
    email,
    email_verified: true,
    name: email,
    iat: now,
    exp: now + 600,
  });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

// Any other outbound request fails the test: nothing here may reach the network.
async function fakeGoogleFetch(input: RequestInfo | URL) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    return Response.json({
      access_token: "FAKE_TEST_ACCESS_TOKEN",
      id_token: googleIdToken(googleUser.email, googleUser.sub),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email profile",
    });
  }
  if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) {
    return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] });
  }
  throw new Error(`unexpected outbound fetch in test: ${url}`);
}

// Only the public URL is pinned so requests from ORIGIN are same-origin; the
// sign-up policy comes from the given config untouched.
function makeAuth(config: Config) {
  return createBetterAuthInstance(testDb.db, {
    ...config,
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
  });
}

function call(auth: Auth, method: "GET" | "POST", path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const headers = new Headers({ origin: ORIGIN });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

function cookiesOf(res: Response) {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function hasSession(res: Response) {
  return res.headers.getSetCookie().some((c) => /session_token=[^;]+/.test(c));
}

async function usersWithEmail(email: string) {
  return (await testDb.db.select().from(authUsers).where(eq(authUsers.email, email))).length;
}

async function googleRedirectSignIn(auth: Auth, email: string, sub: string) {
  googleUser = { email, sub };
  const start = await call(auth, "POST", "/sign-in/social", {
    body: { provider: "google", callbackURL: "/", disableRedirect: true },
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  return call(auth, "GET", `/callback/google?code=FAKE_TEST_CODE&state=${encodeURIComponent(state!)}`, {
    cookie: cookiesOf(start),
  });
}

function googleIdTokenSignIn(auth: Auth, email: string, sub: string) {
  return call(auth, "POST", "/sign-in/social", {
    body: { provider: "google", callbackURL: "/", requestSignUp: true, idToken: { token: googleIdToken(email, sub) } },
  });
}

function unique(tag: string) {
  return `${tag}-${randomUUID().slice(0, 8)}@example.test`;
}

beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "FAKE_TEST_BETTER_AUTH_SECRET_0123456789abcdef");
  vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "FAKE_TEST_GOOGLE_CLIENT_SECRET");
  // config.ts loads $PAPERCLIP_HOME/.env at import: keep it off the real home.
  vi.stubEnv("PAPERCLIP_HOME", mkdtempSync(join(tmpdir(), "paperclip-a5-import-")));
  ({ loadConfig } = await import("../config.js"));
  vi.stubEnv("PAPERCLIP_HOME", undefined);
  productionConfig = configFromEnv(dockerfileRailwayEnv());
  // The documented recovery path: a Railway variable overriding the image ENV.
  recoveryConfig = configFromEnv(dockerfileRailwayEnv(), { PAPERCLIP_AUTH_DISABLE_SIGN_UP: "false" });
  testDb = await startTestDb();
  vi.stubGlobal("fetch", fakeGoogleFetch);
  openAuth = makeAuth(recoveryConfig);
  closedAuth = makeAuth(productionConfig);
}, 300_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await testDb?.stop();
});

describe("sign-up policy applies to every provider", { timeout: 60_000 }, () => {
  it("Dockerfile.railway closes sign-up; without that ENV the code default is open", () => {
    expect(dockerfileRailwayEnv().PAPERCLIP_AUTH_DISABLE_SIGN_UP).toBe("true");
    expect(productionConfig.authDisableSignUp).toBe(true);
    expect(recoveryConfig.authDisableSignUp).toBe(false);
    // Control: the same image ENV minus that line leaves registration open.
    const { PAPERCLIP_AUTH_DISABLE_SIGN_UP: _dropped, ...rest } = dockerfileRailwayEnv();
    expect(configFromEnv(rest).authDisableSignUp).toBe(false);
  });

  it("email/password: production config refuses a new account; the recovery override allows it", async () => {
    const blocked = unique("email-blocked");
    const res = await call(closedAuth, "POST", "/sign-up/email", {
      body: { name: "x", email: blocked, password: "FAKE_TEST_PASSWORD_123" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await usersWithEmail(blocked)).toBe(0);

    const allowed = unique("email-allowed");
    const ok = await call(openAuth, "POST", "/sign-up/email", {
      body: { name: "x", email: allowed, password: "FAKE_TEST_PASSWORD_123" },
    });
    expect(ok.status).toBe(200);
    expect(await usersWithEmail(allowed)).toBe(1);
  });

  it("google redirect flow: production config refuses a new account; the recovery override allows it", async () => {
    const blocked = unique("google-blocked");
    const res = await googleRedirectSignIn(closedAuth, blocked, `sub-${randomUUID()}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/error=/);
    expect(hasSession(res)).toBe(false);
    expect(await usersWithEmail(blocked)).toBe(0);

    const allowed = unique("google-allowed");
    const ok = await googleRedirectSignIn(openAuth, allowed, `sub-${randomUUID()}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).not.toMatch(/error=/);
    expect(hasSession(ok)).toBe(true);
    expect(await usersWithEmail(allowed)).toBe(1);
  });

  it("google id token: production config refuses a new account even with requestSignUp; the recovery override allows it", async () => {
    const blocked = unique("idtoken-blocked");
    const res = await googleIdTokenSignIn(closedAuth, blocked, `sub-${randomUUID()}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(hasSession(res)).toBe(false);
    expect(await usersWithEmail(blocked)).toBe(0);

    const allowed = unique("idtoken-allowed");
    const ok = await googleIdTokenSignIn(openAuth, allowed, `sub-${randomUUID()}`);
    expect(ok.status).toBe(200);
    expect(hasSession(ok)).toBe(true);
    expect(await usersWithEmail(allowed)).toBe(1);
  });

  it("production config: an existing owner still signs in by password, Google redirect and Google id token", async () => {
    const owner = unique("owner");
    const password = "FAKE_TEST_OWNER_PASSWORD_123";
    const created = await call(openAuth, "POST", "/sign-up/email", { body: { name: "Owner", email: owner, password } });
    expect(created.status).toBe(200);

    const byPassword = await call(closedAuth, "POST", "/sign-in/email", { body: { email: owner, password } });
    expect(byPassword.status).toBe(200);
    expect(hasSession(byPassword)).toBe(true);

    // First Google sign-in links to the existing user by verified email.
    const ownerSub = `sub-${randomUUID()}`;
    const byGoogle = await googleRedirectSignIn(closedAuth, owner, ownerSub);
    expect(byGoogle.status).toBe(302);
    expect(byGoogle.headers.get("location")).not.toMatch(/error=/);
    expect(hasSession(byGoogle)).toBe(true);

    const byIdToken = await googleIdTokenSignIn(closedAuth, owner, ownerSub);
    expect(byIdToken.status).toBe(200);
    expect(hasSession(byIdToken)).toBe(true);

    expect(await usersWithEmail(owner)).toBe(1);
  });
});

describe("Better Auth secret", () => {
  it("refuses to build an instance without BETTER_AUTH_SECRET or PAPERCLIP_AGENT_JWT_SECRET", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", undefined);
    try {
      expect(() => makeAuth(productionConfig)).toThrow(/BETTER_AUTH_SECRET/);
      vi.stubEnv("BETTER_AUTH_SECRET", "   ");
      expect(() => makeAuth(productionConfig)).toThrow(/BETTER_AUTH_SECRET/);
      // Control: the agent JWT secret alone is still accepted, as index.ts allows.
      vi.stubEnv("BETTER_AUTH_SECRET", undefined);
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "FAKE_TEST_AGENT_JWT_SECRET_0123456789");
      expect(() => makeAuth(productionConfig)).not.toThrow();
    } finally {
      vi.stubEnv("BETTER_AUTH_SECRET", "FAKE_TEST_BETTER_AUTH_SECRET_0123456789abcdef");
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", undefined);
    }
  });
});
