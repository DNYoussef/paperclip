import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { authUsers, instanceUserRoles } from "@paperclipai/db";
import { bootstrapCeoInvite } from "../../../cli/src/commands/auth-bootstrap-ceo.js";
import { createApp } from "../app.js";
import { createBetterAuthHandler, createBetterAuthInstance, resolveBetterAuthSession } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import { seedWorld } from "./helpers/real-app.js";
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

// PAPERCLIP_* pairs of every ENV instruction in a repo-root Dockerfile. Other
// keys (NODE_ENV, HOME) would change the test process itself.
function dockerfileEnv(file: "Dockerfile.railway" | "Dockerfile" = "Dockerfile.railway") {
  const text = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of text.replace(/\r/g, "").replace(/\\\n/g, " ").split("\n")) {
    if (!line.startsWith("ENV ")) continue;
    for (const m of line.slice(4).matchAll(/(PAPERCLIP_[A-Za-z0-9_]+)=(\S+)/g)) env[m[1]] = m[2];
  }
  return env;
}

// Config as an image with this ENV builds it. Home and config file point at
// an empty temp dir (the Railway service has no config.json); the Railway
// markers are absent unless an override sets them.
function configFromEnv(env: Record<string, string>, overrides: Record<string, string | undefined> = {}) {
  const home = mkdtempSync(join(tmpdir(), "paperclip-a5-home-"));
  const vars: Record<string, string | undefined> = {
    RAILWAY_ENVIRONMENT_ID: undefined,
    RAILWAY_ENVIRONMENT_NAME: undefined,
    ...env,
    PAPERCLIP_HOME: home,
    PAPERCLIP_CONFIG: join(home, "config.json"),
    ...overrides,
  };
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  try {
    return loadConfig();
  } finally {
    for (const name of Object.keys(vars)) vi.stubEnv(name, undefined);
  }
}

const ON_RAILWAY = { RAILWAY_ENVIRONMENT_ID: "FAKE_TEST_ENVIRONMENT_ID" };

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
  productionConfig = configFromEnv(dockerfileEnv(), ON_RAILWAY);
  // The documented recovery path: a Railway variable overriding the image ENV.
  recoveryConfig = configFromEnv(dockerfileEnv(), { ...ON_RAILWAY, PAPERCLIP_AUTH_DISABLE_SIGN_UP: "false" });
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
  it("Dockerfile.railway closes sign-up; only an explicit false reopens it", () => {
    expect(dockerfileEnv().PAPERCLIP_AUTH_DISABLE_SIGN_UP).toBe("true");
    expect(productionConfig.authDisableSignUp).toBe(true);
    expect(recoveryConfig.authDisableSignUp).toBe(false);
    expect(configFromEnv(dockerfileEnv()).authDisableSignUp).toBe(true);
  });

  it("on Railway sign-up is closed whichever Dockerfile built the image", () => {
    const { PAPERCLIP_AUTH_DISABLE_SIGN_UP: _dropped, ...withoutLine } = dockerfileEnv();
    expect(dockerfileEnv("Dockerfile").PAPERCLIP_AUTH_DISABLE_SIGN_UP).toBeUndefined();
    expect(configFromEnv(dockerfileEnv("Dockerfile"), ON_RAILWAY).authDisableSignUp).toBe(true);
    expect(configFromEnv(dockerfileEnv("Dockerfile"), { RAILWAY_ENVIRONMENT_NAME: "production" }).authDisableSignUp).toBe(true);
    expect(configFromEnv(withoutLine, ON_RAILWAY).authDisableSignUp).toBe(true);
    // Control: off Railway, without the image line, the upstream default (open) holds.
    expect(configFromEnv(dockerfileEnv("Dockerfile")).authDisableSignUp).toBe(false);
    expect(configFromEnv(withoutLine).authDisableSignUp).toBe(false);
  });

  it("root Dockerfile settings on Railway: email and Google sign-up are refused end to end", async () => {
    const rootOnRailway = makeAuth(configFromEnv(dockerfileEnv("Dockerfile"), ON_RAILWAY));

    const byEmail = unique("root-email");
    const email = await call(rootOnRailway, "POST", "/sign-up/email", {
      body: { name: "x", email: byEmail, password: "FAKE_TEST_PASSWORD_123" },
    });
    expect(email.status).toBeGreaterThanOrEqual(400);
    expect(await usersWithEmail(byEmail)).toBe(0);

    const byRedirect = unique("root-redirect");
    const redirect = await googleRedirectSignIn(rootOnRailway, byRedirect, `sub-${randomUUID()}`);
    expect(redirect.headers.get("location")).toMatch(/error=/);
    expect(await usersWithEmail(byRedirect)).toBe(0);

    const byIdToken = unique("root-idtoken");
    const idToken = await googleIdTokenSignIn(rootOnRailway, byIdToken, `sub-${randomUUID()}`);
    expect(idToken.status).toBeGreaterThanOrEqual(400);
    expect(await usersWithEmail(byIdToken)).toBe(0);
  });

  it("PAPERCLIP_AUTH_DISABLE_SIGN_UP accepts only true/false; anything else stops startup", () => {
    for (const bad of ["1", "0", "TRUE", "True", "true ", " true", "", "yes", "no", "FALSE", "false "]) {
      for (const where of [ON_RAILWAY, {}]) {
        expect(
          () => configFromEnv(dockerfileEnv(), { ...where, PAPERCLIP_AUTH_DISABLE_SIGN_UP: bad }),
          JSON.stringify(bad),
        ).toThrow(/PAPERCLIP_AUTH_DISABLE_SIGN_UP/);
      }
    }
    expect(configFromEnv(dockerfileEnv("Dockerfile"), { PAPERCLIP_AUTH_DISABLE_SIGN_UP: "true" }).authDisableSignUp).toBe(true);
    expect(
      configFromEnv(dockerfileEnv("Dockerfile"), { ...ON_RAILWAY, PAPERCLIP_AUTH_DISABLE_SIGN_UP: "false" }).authDisableSignUp,
    ).toBe(false);
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

// The real app (every router, real Better Auth) over the test database.
function appWith(auth: Auth) {
  return createApp(testDb.db, {
    uiMode: "none",
    serverPort: 0,
    storageService: {} as any,
    deploymentMode: "authenticated",
    deploymentExposure: "public",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: false,
    betterAuthHandler: createBetterAuthHandler(auth),
    resolveSession: (req) => resolveBetterAuthSession(auth, req),
  });
}

function sessionCookie(res: request.Response) {
  return ([] as string[]).concat(res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
}

describe("owner recovery on an env-only Railway deployment", { timeout: 120_000 }, () => {
  it("reopen, bootstrap-ceo without config.json, accept, close again: the new account is instance admin", async () => {
    // The locked-out owner is world.users.admin, an existing instance admin.
    const world = await seedWorld(testDb.db);
    const password = "FAKE_TEST_RECOVERY_PASSWORD_123";
    const email = unique("recovered-owner");

    // 1. Railway variable PAPERCLIP_AUTH_DISABLE_SIGN_UP=false, redeploy.
    const reopened = await appWith(makeAuth(recoveryConfig));

    // 2. In the service shell: no config.json, env from the image and Railway.
    const home = mkdtempSync(join(tmpdir(), "paperclip-a5-cli-"));
    vi.stubEnv("PAPERCLIP_CONFIG", join(home, "config.json"));
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", dockerfileEnv().PAPERCLIP_DEPLOYMENT_MODE);
    vi.stubEnv("DATABASE_URL", testDb.url);
    let inviteUrl: string | undefined;
    try {
      inviteUrl = await bootstrapCeoInvite({ force: true, baseUrl: ORIGIN });
    } finally {
      vi.stubEnv("PAPERCLIP_CONFIG", undefined);
      vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", undefined);
      vi.stubEnv("DATABASE_URL", undefined);
    }
    expect(inviteUrl).toMatch(/^http:\/\/localhost:3100\/invite\/pcp_bootstrap_[0-9a-f]+$/);
    const token = inviteUrl!.split("/invite/")[1];

    // 3. Create the account and accept the invite while sign-up is open.
    const signUp = await request(reopened)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ name: "Recovered owner", email, password });
    expect(signUp.status).toBe(200);
    const cookie = sessionCookie(signUp);
    // Control: a fresh account alone has no access to existing companies.
    const before = await request(reopened).get("/api/companies").set("origin", ORIGIN).set("cookie", cookie);
    expect(JSON.stringify(before.body)).not.toContain(world.companyA.id);

    const accept = await request(reopened)
      .post(`/api/invites/${token}/accept`)
      .set("origin", ORIGIN)
      .set("cookie", cookie)
      .send({ requestType: "human" });
    expect(accept.status).toBe(202);
    expect(accept.body.bootstrapAccepted).toBe(true);
    const roles = await testDb.db
      .select()
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.userId, accept.body.userId));
    expect(roles.map((r) => r.role)).toContain("instance_admin");

    // 4. Delete the variable, redeploy: closed again, the new admin keeps access.
    const closed = await appWith(makeAuth(productionConfig));
    const stranger = await request(closed)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ name: "x", email: unique("after-close"), password });
    expect(stranger.status).toBeGreaterThanOrEqual(400);
    const signIn = await request(closed).post("/api/auth/sign-in/email").set("origin", ORIGIN).send({ email, password });
    expect(signIn.status).toBe(200);
    const after = await request(closed).get("/api/companies").set("origin", ORIGIN).set("cookie", sessionCookie(signIn));
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).toContain(world.companyA.id);
    expect(JSON.stringify(after.body)).toContain(world.companyB.id);
  });
});
