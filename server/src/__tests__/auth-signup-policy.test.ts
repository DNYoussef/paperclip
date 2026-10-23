import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authAccounts, authSessions, authUsers, instanceUserRoles } from "@paperclipai/db";
import { createApp } from "../app.js";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSession,
  resolveBetterAuthSessionFromHeaders,
} from "../auth/better-auth.js";
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
    // A marker that is present but empty still means Railway.
    expect(configFromEnv(dockerfileEnv("Dockerfile"), { RAILWAY_ENVIRONMENT_ID: "" }).authDisableSignUp).toBe(true);
    expect(configFromEnv(dockerfileEnv("Dockerfile"), { RAILWAY_ENVIRONMENT_NAME: "" }).authDisableSignUp).toBe(true);
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

const RECOVER_SCRIPT = fileURLToPath(new URL("../auth/recover-admin.ts", import.meta.url));
const TSX_LOADER = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

// The documented operator command, run the way the Railway shell runs it:
// node with the server's tsx loader, DATABASE_URL from the environment.
function runRecoverAdmin(email: string) {
  const out = execFileSync(process.execPath, ["--import", TSX_LOADER, RECOVER_SCRIPT, email], {
    env: { ...process.env, DATABASE_URL: testDb.url },
    encoding: "utf8",
  });
  const password = /One-time password: (\S+)/.exec(out)?.[1];
  expect(password, out).toBeTruthy();
  return password!;
}

// The server's own session resolver (what the actor middleware uses).
function sessionOf(cookie: string) {
  return resolveBetterAuthSessionFromHeaders(closedAuth, new Headers({ cookie }));
}

async function signIn(app: Awaited<ReturnType<typeof appWith>>, email: string, password: string) {
  return request(app).post("/api/auth/sign-in/email").set("origin", ORIGIN).send({ email, password });
}

describe("owner recovery never opens sign-up", { timeout: 120_000 }, () => {
  it("an attacker who registered the owner's email in an earlier open window keeps nothing after recovery", async () => {
    const world = await seedWorld(testDb.db);
    const email = unique("owner-target");
    const ownerSub = `sub-${randomUUID()}`;
    const open = await appWith(openAuth);
    const closed = await appWith(closedAuth);

    // Earlier open window: the attacker registers the owner's email.
    const attackerPassword = "FAKE_TEST_ATTACKER_PASSWORD_123";
    const planted = await request(open)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ name: "attacker", email, password: attackerPassword });
    expect(planted.status).toBe(200);
    const attackerCookie = sessionCookie(planted);
    // The owner's verified Google sign-in links to that same user.
    const ownerGoogle = await googleRedirectSignIn(closedAuth, email, ownerSub);
    expect(ownerGoogle.headers.get("location")).not.toMatch(/error=/);
    // Control: before recovery the attacker's password and session work.
    expect((await signIn(closed, email, attackerPassword)).status).toBe(200);
    expect((await sessionOf(attackerCookie))?.user?.email).toBe(email);

    const newPassword = runRecoverAdmin(email);

    // Sign-up was never reopened: the running policy is still closed.
    expect(productionConfig.authDisableSignUp).toBe(true);
    // The attacker's password, session and the old Google link are gone.
    expect((await signIn(closed, email, attackerPassword)).status).toBeGreaterThanOrEqual(400);
    expect(await sessionOf(attackerCookie)).toBeNull();
    const [user] = await testDb.db.select().from(authUsers).where(eq(authUsers.email, email));
    const accounts = await testDb.db.select().from(authAccounts).where(eq(authAccounts.userId, user!.id));
    expect(accounts.map((a) => a.providerId)).toEqual(["credential"]);
    expect(await usersWithEmail(email)).toBe(1);

    // The operator's fresh password works and the account is instance admin.
    const owner = await signIn(closed, email, newPassword);
    expect(owner.status).toBe(200);
    const roles = await testDb.db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, user!.id));
    expect(roles.map((r) => r.role)).toContain("instance_admin");
    const companies = await request(closed).get("/api/companies").set("origin", ORIGIN).set("cookie", sessionCookie(owner));
    expect(companies.status).toBe(200);
    expect(JSON.stringify(companies.body)).toContain(world.companyA.id);
    expect(JSON.stringify(companies.body)).toContain(world.companyB.id);
  });

  it("recovering an email with no account creates a fresh instance admin while sign-up stays closed", async () => {
    const email = unique("fresh-admin");
    const closed = await appWith(closedAuth);
    // Control: that email cannot self-register.
    const refused = await request(closed)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ name: "x", email, password: "FAKE_TEST_PASSWORD_123" });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const password = runRecoverAdmin(email);
    const login = await signIn(closed, email, password);
    expect(login.status).toBe(200);
    const [user] = await testDb.db.select().from(authUsers).where(eq(authUsers.email, email));
    const roles = await testDb.db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, user!.id));
    expect(roles.map((r) => r.role)).toContain("instance_admin");
  });
});

// Same command, without throwing, so a refusal can be asserted.
function runRecoverAdminAsync(email: string) {
  return new Promise<{ code: number; out: string; password?: string }>((resolve) => {
    execFile(
      process.execPath,
      ["--import", TSX_LOADER, RECOVER_SCRIPT, email],
      { env: { ...process.env, DATABASE_URL: testDb.url }, encoding: "utf8" },
      (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`;
        resolve({
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
          out,
          password: /One-time password: (\S+)/.exec(out)?.[1],
        });
      },
    );
  });
}

// A real Better Auth instance over the real database, except that the request
// stops right before its first credential or session write: at the first
// transaction it opens, or at a plain insert/update on the given table,
// whichever comes first. The request has done its checks (password verified,
// provider identity resolved); nothing is written yet. `failDelete` makes the
// server's deletes on that table fail, as a lost database connection would.
function pausedWrite(config: Config, pause: { insert?: unknown; update?: unknown; failDelete?: unknown }) {
  let resume!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  let reached!: () => void;
  const paused = new Promise<void>((r) => (reached = r));
  let armed = true;
  const stop = async () => {
    if (!armed) return;
    armed = false;
    reached();
    await gate;
  };
  const real = testDb.db as any;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "transaction") {
        return async (fn: unknown, ...rest: unknown[]) => {
          await stop();
          return target.transaction(fn, ...rest);
        };
      }
      if (prop === "insert") {
        return (table: unknown) => {
          if (table !== pause.insert) return target.insert(table);
          return {
            values: (values: unknown) => ({
              returning: async () => {
                await stop();
                return target.insert(table).values(values).returning();
              },
            }),
          };
        };
      }
      if (prop === "update") {
        return (table: unknown) => {
          if (table !== pause.update) return target.update(table);
          return {
            set: (values: unknown) => ({
              where: (...clause: unknown[]) => {
                const run = async (finish: (b: any) => unknown) => {
                  await stop();
                  return finish(target.update(table).set(values).where(...clause));
                };
                return {
                  then: (ok: any, bad: any) => run((b) => b).then(ok, bad),
                  returning: () => run((b) => b.returning()),
                };
              },
            }),
          };
        };
      }
      if (prop === "delete" && pause.failDelete) {
        return (table: unknown) => {
          if (table === pause.failDelete) throw new Error("simulated database loss during cleanup");
          return target.delete(table);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const auth = createBetterAuthInstance(db, { ...config, authBaseUrlMode: "explicit", authPublicBaseUrl: ORIGIN });
  return { auth, paused, resume };
}

// recoverInstanceAdmin in this process, stopped inside its credential
// transaction (at its first delete), so another recovery or a login can run
// while it is open.
async function pausedRecovery(email: string) {
  const { recoverInstanceAdmin } = await import("../auth/recover-admin.js");
  let resume!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  let reached!: () => void;
  const paused = new Promise<void>((r) => (reached = r));
  let armed = true;
  const real = testDb.db as any;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "transaction") {
        return (fn: (tx: any) => unknown, ...rest: unknown[]) =>
          target.transaction(
            (tx: any) =>
              fn(
                new Proxy(tx, {
                  get(t, q) {
                    if (q === "delete" && armed) {
                      return (table: unknown) => {
                        const builder = t.delete(table);
                        return {
                          where: (...c: unknown[]) => ({
                            returning: async () => {
                              armed = false;
                              reached();
                              await gate;
                              return builder.where(...c).returning();
                            },
                          }),
                        };
                      };
                    }
                    const v = t[q];
                    return typeof v === "function" ? v.bind(t) : v;
                  },
                }),
              ),
            ...rest,
          );
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const done = recoverInstanceAdmin(db, email);
  return { done, paused, resume };
}

async function lockWaiters() {
  const rows = (await testDb.db.execute(
    sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function waitFor(cond: () => Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function plantAttacker(email: string, password: string) {
  const planted = await call(openAuth, "POST", "/sign-up/email", { body: { name: "attacker", email, password } });
  expect(planted.status).toBe(200);
  return cookiesOf(planted);
}

async function signInStatus(email: string, password: string) {
  return (await call(closedAuth, "POST", "/sign-in/email", { body: { email, password } })).status;
}

describe("owner recovery is safe against in-flight authentication (no server lease)", { timeout: 120_000 }, () => {
  it("an old-password login paused after verification gets no usable session; recovery runs while serving", async () => {
    const email = unique("inflight");
    const attackerPassword = "FAKE_TEST_ATTACKER_PASSWORD_456";
    await plantAttacker(email, attackerPassword);

    const server = pausedWrite(productionConfig, { insert: authSessions });
    const login = call(server.auth, "POST", "/sign-in/email", { body: { email, password: attackerPassword } });
    await server.paused;
    const recovery = await runRecoverAdminAsync(email);
    expect(recovery.code, recovery.out).toBe(0);
    // Drop every other database connection, as a network blip or a pooler
    // reassigning backends would: nothing depends on connection state.
    await testDb.db.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`,
    );
    // Let the pool notice the closed sockets so the resumed request fails or
    // succeeds on the epoch check, not on a dead socket.
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 12; i++) await testDb.db.execute(sql`select 1`).catch(() => {});
    server.resume();
    const resumed = await login;

    expect(resumed.status).toBeGreaterThanOrEqual(400);
    expect(await resumed.clone().text()).toMatch(/Credentials changed/);
    expect(await sessionOf(cookiesOf(resumed))).toBeNull();
    expect(await signInStatus(email, attackerPassword)).toBeGreaterThanOrEqual(400);
    expect(await signInStatus(email, recovery.password!)).toBe(200);
  });

  it("a password change paused before its write cannot replace the recovered credential", async () => {
    const email = unique("pwchange");
    const attackerPassword = "FAKE_TEST_ATTACKER_PASSWORD_789";
    const attackerCookie = await plantAttacker(email, attackerPassword);

    const server = pausedWrite(productionConfig, { update: authAccounts });
    const change = server.auth.handler(
      new Request(`${ORIGIN}/api/auth/change-password`, {
        method: "POST",
        headers: { origin: ORIGIN, cookie: attackerCookie, "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: attackerPassword, newPassword: "FAKE_TEST_ATTACKER_NEW_PW_1" }),
      }),
    );
    await server.paused;
    const recovery = await runRecoverAdminAsync(email);
    expect(recovery.code, recovery.out).toBe(0);
    server.resume();
    const changed = await change;

    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(await changed.clone().text()).toMatch(/Credentials changed/);
    expect(await signInStatus(email, "FAKE_TEST_ATTACKER_NEW_PW_1")).toBeGreaterThanOrEqual(400);
    expect(await signInStatus(email, attackerPassword)).toBeGreaterThanOrEqual(400);
    // The recovered credential was never touched.
    expect(await signInStatus(email, recovery.password!)).toBe(200);
  });

  it("a Google link paused before its write is not left behind and yields no session", async () => {
    const email = unique("gl-link");
    await plantAttacker(email, "FAKE_TEST_ATTACKER_PASSWORD_000");

    const server = pausedWrite(productionConfig, { insert: authAccounts });
    const link = googleRedirectSignIn(server.auth, email, `sub-${randomUUID()}`);
    await server.paused;
    const recovery = await runRecoverAdminAsync(email);
    expect(recovery.code, recovery.out).toBe(0);
    server.resume();
    const linked = await link;

    expect(linked.headers.get("location")).toMatch(/error=/);
    expect(await sessionOf(cookiesOf(linked))).toBeNull();
    const [user] = await testDb.db.select().from(authUsers).where(eq(authUsers.email, email));
    const accounts = await testDb.db.select().from(authAccounts).where(eq(authAccounts.userId, user!.id));
    expect(accounts.map((a) => a.providerId)).toEqual(["credential"]);
    expect(await signInStatus(email, recovery.password!)).toBe(200);
  });

  it("overlapping recoveries: a login verified before the last recovery commits gets no session", async () => {
    const email = unique("overlap");
    const attackerPassword = "FAKE_TEST_ATTACKER_PASSWORD_321";
    await plantAttacker(email, attackerPassword);

    // Recovery A is open (inside its credential transaction).
    const a = await pausedRecovery(email);
    await a.paused;
    // Recovery B starts; it may finish (no serialization) or wait for A.
    const b = runRecoverAdminAsync(email);
    let bDone = false;
    void b.then(() => (bDone = true));
    await waitFor(async () => bDone || (await lockWaiters()) > 0);
    const bEarly = bDone ? await b : null;
    // A login verifies whatever credential is current now, then stops
    // right before writing its session.
    const current = bEarly ? bEarly.password! : attackerPassword;
    const server = pausedWrite(productionConfig, { insert: authSessions });
    const login = call(server.auth, "POST", "/sign-in/email", { body: { email, password: current } });
    await Promise.race([server.paused, login]);
    // A commits, then B (if it was waiting) commits.
    a.resume();
    const aResult = await a.done;
    const bResult = await b;
    expect(bResult.code, bResult.out).toBe(0);
    server.resume();
    const resumed = await login;

    expect(resumed.status).toBeGreaterThanOrEqual(400);
    expect(await sessionOf(cookiesOf(resumed))).toBeNull();
    expect(await signInStatus(email, attackerPassword)).toBeGreaterThanOrEqual(400);
    // Exactly one recovery's password is the live one: whichever committed last.
    const live = [aResult.password, bResult.password!].map(async (pw) => (await signInStatus(email, pw)) === 200);
    expect((await Promise.all(live)).filter(Boolean)).toHaveLength(1);
  });

  it("a stale Google link never becomes visible, even if cleanup could not run", async () => {
    const email = unique("gl-stale");
    await plantAttacker(email, "FAKE_TEST_ATTACKER_PASSWORD_111");
    const sub = `sub-${randomUUID()}`;

    const server = pausedWrite(productionConfig, { insert: authAccounts, failDelete: authAccounts });
    const link = googleRedirectSignIn(server.auth, email, sub);
    await server.paused;
    const recovery = await runRecoverAdminAsync(email);
    expect(recovery.code, recovery.out).toBe(0);
    server.resume();
    const linked = await link;
    expect(await sessionOf(cookiesOf(linked))).toBeNull();

    // A second login with the same Google subject but another email works
    // only through a linked row; there must be none.
    const second = await googleRedirectSignIn(closedAuth, unique("other-mail"), sub);
    expect(second.headers.get("location")).toMatch(/error=/);
    expect(await sessionOf(cookiesOf(second))).toBeNull();
    const [user] = await testDb.db.select().from(authUsers).where(eq(authUsers.email, email));
    const accounts = await testDb.db.select().from(authAccounts).where(eq(authAccounts.userId, user!.id));
    expect(accounts.map((x) => x.providerId)).toEqual(["credential"]);
  });

  it("a real wrapped session write paused after its epoch check holds recovery off; recovery then removes it", async () => {
    const email = unique("wrapped");
    const owner = await runRecoverAdminAsync(email);
    expect(owner.code, owner.out).toBe(0);

    // Better Auth over the real wrapper (withConditionalCredentialWrites),
    // stopped INSIDE the wrapper's transaction: after it locked and compared
    // the epoch, before its session INSERT and commit.
    let resume!: () => void;
    const gate = new Promise<void>((r) => (resume = r));
    let reached!: () => void;
    const paused = new Promise<void>((r) => (reached = r));
    let armed = true;
    const real = testDb.db as any;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === "transaction") {
          return (fn: (tx: any) => unknown, ...rest: unknown[]) =>
            target.transaction(
              (tx: any) =>
                fn(
                  new Proxy(tx, {
                    get(t, q) {
                      if (q === "insert") {
                        return (table: unknown) => {
                          if (table !== authSessions || !armed) return t.insert(table);
                          return {
                            values: (values: unknown) => ({
                              returning: async () => {
                                armed = false;
                                reached();
                                await gate;
                                return t.insert(table).values(values).returning();
                              },
                            }),
                          };
                        };
                      }
                      const v = t[q];
                      return typeof v === "function" ? v.bind(t) : v;
                    },
                  }),
                ),
              ...rest,
            );
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const server = createBetterAuthInstance(db, { ...productionConfig, authBaseUrlMode: "explicit", authPublicBaseUrl: ORIGIN });
    const login = server.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email, password: owner.password }),
      }),
    );
    await Promise.race([paused, login]);

    // Recovery must wait for the open write (it needs the epoch row).
    let recovered = false;
    const recovery = runRecoverAdminAsync(email).then((r) => ((recovered = true), r));
    try {
      await waitFor(async () => recovered || (await lockWaiters()) > 0);
      expect(recovered, "recovery finished while a checked write was still open").toBe(false);
    } finally {
      resume(); // never leave the write's transaction open
    }

    // The write commits; only then can recovery run, and it removes it.
    const loggedIn = await login;
    expect(loggedIn.status).toBe(200);
    const r = await recovery;
    expect(r.code, r.out).toBe(0);
    expect(await sessionOf(cookiesOf(loggedIn))).toBeNull();
    expect(await signInStatus(email, owner.password!)).toBeGreaterThanOrEqual(400);
    expect(await signInStatus(email, r.password!)).toBe(200);
  });

  it("a recovery that fails part-way changes nothing and blocks no one", async () => {
    const email = unique("partial");
    const first = await runRecoverAdminAsync(email);
    expect(first.code, first.out).toBe(0);
    const { readCredentialEpoch } = await import("../auth/credential-epoch.js");
    const { recoverInstanceAdmin } = await import("../auth/recover-admin.js");
    const before = await readCredentialEpoch(testDb.db);
    // The process dies after deleting the old credentials, before commit.
    const crashing = new Proxy(testDb.db as any, {
      get(target, prop) {
        if (prop === "transaction") {
          return (fn: (tx: any) => unknown) =>
            target.transaction((tx: any) =>
              fn(
                new Proxy(tx, {
                  get(t, q) {
                    if (q === "insert") {
                      return (table: unknown) => {
                        if (table === authAccounts) throw new Error("simulated crash");
                        return t.insert(table);
                      };
                    }
                    const v = t[q];
                    return typeof v === "function" ? v.bind(t) : v;
                  },
                }),
              ),
            );
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(recoverInstanceAdmin(crashing, email)).rejects.toThrow(/simulated crash/);
    expect(await readCredentialEpoch(testDb.db)).toBe(before);
    expect(await signInStatus(email, first.password!)).toBe(200);
  });
});
