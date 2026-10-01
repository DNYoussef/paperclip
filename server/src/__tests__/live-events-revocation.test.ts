import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, approvals } from "@paperclipai/db";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { accessService } from "../services/index.js";
import { publishLiveEvent } from "../services/live-events.js";
import { buildApp, send, seedWorld, startRealApp, type RealApp, type World } from "./helpers/real-app.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createApp } from "../app.js";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSession,
  resolveBetterAuthSessionFromHeaders,
} from "../auth/better-auth.js";
import { companyMemberships } from "@paperclipai/db";
import request from "supertest";

// SEC-060 end to end: real WebSocket clients against the real upgrade
// handler, the real app and PostgreSQL. Each revocation is performed by the
// real operation (HTTP route or service call), never by calling the close
// helper directly. A revoked principal's socket closes with 1008, stops
// receiving events, and a reconnect attempt is refused at upgrade.

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as any;

let real: RealApp;
let server: Server;
let wss: { close: () => void };
let base: string;
// The real Better Auth instance over the same database. Board sockets that
// carry a session cookie are authorized through it; the rest of the file
// uses header-driven test sessions.
let auth: ReturnType<typeof createBetterAuthInstance>;
let authApp: Awaited<ReturnType<typeof createApp>>;
const AUTH_ORIGIN = "http://localhost:3100";

beforeAll(async () => {
  real = await startRealApp();
  auth = createBetterAuthInstance(real.db, {
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: AUTH_ORIGIN,
    deploymentMode: "authenticated",
    allowedHostnames: [],
    authDisableSignUp: false,
  } as any);
  authApp = await createApp(real.db, {
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
  server = createServer(real.app);
  wss = setupLiveEventsWebSocketServer(server, real.db as any, {
    deploymentMode: "authenticated",
    resolveSessionFromHeaders: async (headers: Headers) => {
      if (headers.get("cookie")) return resolveBetterAuthSessionFromHeaders(auth, headers);
      const userId = headers.get("x-test-user");
      if (!userId) return null;
      const sessionId = headers.get("x-test-session") ?? `session-${userId}`;
      return { session: { id: sessionId, userId }, user: { id: userId, email: null, name: null } } as any;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  // Sockets a failing run left open must not hold the server open.
  for (const client of (wss as any)?.clients ?? []) client.terminate();
  wss?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await real?.stop();
});

interface Client {
  ws: any;
  events: unknown[];
  closed: Promise<{ code: number }>;
}

type Who = { token: string } | { userId: string; sessionId?: string } | { cookie: string };

function open(companyId: string, who: Who): Promise<Client> {
  const headers: Record<string, string> =
    "token" in who
      ? { authorization: `Bearer ${who.token}` }
      : "cookie" in who
        ? { cookie: who.cookie }
        : { "x-test-user": who.userId, ...(who.sessionId ? { "x-test-session": who.sessionId } : {}) };
  const ws = new WebSocket(`${base}/api/companies/${companyId}/events/ws`, { headers });
  const events: unknown[] = [];
  ws.on("message", (data: Buffer) => events.push(JSON.parse(data.toString())));
  const closed = new Promise<{ code: number }>((resolve) => ws.on("close", (code: number) => resolve({ code })));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, events, closed }));
    ws.once("unexpected-response", (_req: unknown, res: { statusCode: number }) => reject(new Error(`upgrade ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

async function expectClosed(client: Client) {
  const result = await Promise.race([
    client.closed,
    new Promise<{ code: number }>((resolve) => setTimeout(() => resolve({ code: -1 }), 3000)),
  ]);
  expect(result.code).toBe(1008);
  const before = client.events.length;
  publishLiveEvent({ companyId: (client as any).companyId, type: "heartbeat.run.log" as any });
  await new Promise((r) => setTimeout(r, 50));
  expect(client.events.length).toBe(before);
}

async function expectOpen(client: Client, companyId: string) {
  const before = client.events.length;
  publishLiveEvent({ companyId, type: "heartbeat.run.log" as any });
  await vi.waitFor(() => expect(client.events.length).toBe(before + 1), { timeout: 2000 });
  expect(client.ws.readyState).toBe(WebSocket.OPEN);
}

async function openTagged(companyId: string, who: Who) {
  const client = await open(companyId, who);
  (client as any).companyId = companyId;
  return client;
}

// Real Better Auth sessions: sign-up/sign-in through the real handler; the
// user joins company A so its cookie can open company A's stream.
function cookieOf(res: { headers: Record<string, unknown> }) {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

function authPost(path: string, cookie: string, body: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  let req = request(authApp).post(path).set("origin", AUTH_ORIGIN).set("cookie", cookie);
  for (const [k, v] of Object.entries(extra)) req = req.set(k, v);
  return req.send(body);
}

let userSeq = 0;
async function signUp(w: World) {
  const email = `u${++userSeq}-${w.companyA.id.slice(0, 8)}@example.test`;
  const res = await request(authApp)
    .post("/api/auth/sign-up/email")
    .set("origin", AUTH_ORIGIN)
    .send({ name: "Test User", email, password: "correct-horse-battery" });
  expect(res.status).toBe(200);
  const userId = res.body.user.id as string;
  await real.db.insert(companyMemberships).values({
    companyId: w.companyA.id,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "member",
  });
  return { email, userId, cookie: cookieOf(res) };
}

async function signIn(email: string) {
  const res = await request(authApp)
    .post("/api/auth/sign-in/email")
    .set("origin", AUTH_ORIGIN)
    .send({ email, password: "correct-horse-battery" });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

async function sessionTokens(cookie: string) {
  const res = await request(authApp).get("/api/auth/list-sessions").set("origin", AUTH_ORIGIN).set("cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as Array<{ id: string; token: string }>;
}

const tokenOf = (w: World) => ({ target: { token: w.keyA.token }, peer: { token: w.keyPeerA.token } });

describe("agent revocation closes live sockets", () => {
  it("key revocation via DELETE /agents/:id/keys/:keyId closes that key's socket only", async () => {
    const w = await seedWorld(real.db);
    const target = await openTagged(w.companyA.id, tokenOf(w).target);
    const peer = await openTagged(w.companyA.id, tokenOf(w).peer);
    await expectOpen(target, w.companyA.id);

    const res = await send(real.app, w.callers.member, "delete", `/api/agents/${w.agentA.id}/keys/${w.keyA.id}`);
    expect(res.status).toBe(200);
    await expectClosed(target);
    await expectOpen(peer, w.companyA.id);
    await expect(open(w.companyA.id, tokenOf(w).target)).rejects.toThrow(/upgrade 403/);
    peer.ws.close();
  });

  it("termination via POST /agents/:id/terminate closes the agent's socket", async () => {
    const w = await seedWorld(real.db);
    const target = await openTagged(w.companyA.id, tokenOf(w).target);
    const res = await send(real.app, w.callers.member, "post", `/api/agents/${w.agentA.id}/terminate`);
    expect(res.status).toBe(200);
    await expectClosed(target);
    await expect(open(w.companyA.id, tokenOf(w).target)).rejects.toThrow(/upgrade 403/);
  });

  it("termination via PATCH /agents/:id status=terminated revokes keys and closes the socket", async () => {
    const w = await seedWorld(real.db);
    const target = await openTagged(w.companyA.id, tokenOf(w).target);
    const peer = await openTagged(w.companyA.id, tokenOf(w).peer);
    const res = await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, { status: "terminated" });
    expect(res.status).toBe(200);
    await expectClosed(target);
    await expectOpen(peer, w.companyA.id);
    // The key itself is revoked, so HTTP is refused too.
    const http = await send(real.app, w.callers.targetAgent, "get", `/api/agents/${w.agentA.id}`);
    expect(http.status).toBe(401);
    await expect(open(w.companyA.id, tokenOf(w).target)).rejects.toThrow(/upgrade 403/);
    peer.ws.close();
  });

  it("termination via hire-approval rejection closes the agent's socket", async () => {
    const w = await seedWorld(real.db);
    const target = await openTagged(w.companyA.id, tokenOf(w).target);
    const approval = await real.db
      .insert(approvals)
      .values({ companyId: w.companyA.id, type: "hire_agent", status: "pending", payload: { agentId: w.agentA.id } })
      .returning()
      .then((r) => r[0]!);
    const res = await send(real.app, w.callers.member, "post", `/api/approvals/${approval.id}/reject`, {});
    expect(res.status).toBe(200);
    await expectClosed(target);
  });

  it("an unrevoked key of a terminated agent cannot open a stream", async () => {
    const w = await seedWorld(real.db);
    await real.db.update(agents).set({ status: "terminated" }).where(eq(agents.id, w.agentA.id));
    await expect(open(w.companyA.id, tokenOf(w).target)).rejects.toThrow(/upgrade 403/);
    // Control: the peer agent of the same company still connects.
    const peer = await openTagged(w.companyA.id, tokenOf(w).peer);
    await expectOpen(peer, w.companyA.id);
    peer.ws.close();
  });

  it("a foreign agent key cannot open company A's stream", async () => {
    const w = await seedWorld(real.db);
    await expect(open(w.companyA.id, { token: w.keyB.token })).rejects.toThrow(/upgrade 403/);
  });
});

describe("revocation during an in-flight upgrade (SEC-060)", () => {
  // A second live-events server whose database handle and session resolver
  // run a hook at a precise point inside upgrade authorization: after the
  // credential checks, before the socket is registered. The hook performs a
  // real revocation through the app.
  let raceServer: Server;
  let raceWss: { close: () => void };
  let raceBase: string;
  const gap: { agent: null | (() => Promise<void>); session: null | (() => Promise<void>) } = { agent: null, session: null };

  beforeAll(async () => {
    const proxiedDb = new Proxy(real.db as any, {
      get(target, prop) {
        // authorizeUpgrade's last await on the agent path is the lastUsedAt
        // update, after the key and agent checks.
        if (prop === "update" && gap.agent) {
          return (table: unknown) => ({
            set: (values: unknown) => ({
              where: async (condition: unknown) => {
                const hook = gap.agent;
                gap.agent = null;
                if (hook) await hook();
                return target.update(table).set(values).where(condition);
              },
            }),
          });
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    raceServer = createServer(real.app);
    raceWss = setupLiveEventsWebSocketServer(raceServer, proxiedDb, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: async (headers: Headers) => {
        const session = await resolveBetterAuthSessionFromHeaders(auth, headers);
        // The session was valid when resolved; logout lands right after.
        const hook = gap.session;
        gap.session = null;
        if (hook) await hook();
        return session as any;
      },
    });
    await new Promise<void>((resolve) => raceServer.listen(0, "127.0.0.1", resolve));
    raceBase = `ws://127.0.0.1:${(raceServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of (raceWss as any)?.clients ?? []) client.terminate();
    raceWss?.close();
    raceServer?.closeAllConnections();
    await new Promise<void>((resolve) => raceServer?.close(() => resolve()));
  });

  function openRace(companyId: string, headers: Record<string, string>): Promise<Client> {
    const ws = new WebSocket(`${raceBase}/api/companies/${companyId}/events/ws`, { headers });
    const events: unknown[] = [];
    ws.on("message", (data: Buffer) => events.push(JSON.parse(data.toString())));
    const closed = new Promise<{ code: number }>((resolve) => ws.on("close", (code: number) => resolve({ code })));
    return new Promise((resolve, reject) => {
      ws.once("open", () => {
        const client = { ws, events, closed } as Client;
        (client as any).companyId = companyId;
        resolve(client);
      });
      ws.once("unexpected-response", (_req: unknown, res: { statusCode: number }) => reject(new Error(`upgrade ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  it("a key revoked after the key check but before registration never streams", async () => {
    const w = await seedWorld(real.db);
    gap.agent = async () => {
      const res = await send(real.app, w.callers.member, "delete", `/api/agents/${w.agentA.id}/keys/${w.keyA.id}`);
      expect(res.status).toBe(200);
    };
    const client = await openRace(w.companyA.id, { authorization: `Bearer ${w.keyA.token}` });
    expect(gap.agent).toBeNull();
    await expectClosed(client);
  });

  it("a session logged out after resolution but before registration never streams", async () => {
    const w = await seedWorld(real.db);
    const user = await signUp(w);
    gap.session = async () => {
      const res = await authPost("/api/auth/sign-out", user.cookie);
      expect(res.status).toBe(200);
    };
    const client = await openRace(w.companyA.id, { cookie: user.cookie });
    expect(gap.session).toBeNull();
    await expectClosed(client);
  });

  it("control: an unrelated revocation in the gap does not close the new stream", async () => {
    const w = await seedWorld(real.db);
    gap.agent = async () => {
      const res = await send(real.app, w.callers.member, "delete", `/api/agents/${w.peerA.id}/keys/${w.keyPeerA.id}`);
      expect(res.status).toBe(200);
    };
    const client = await openRace(w.companyA.id, { authorization: `Bearer ${w.keyA.token}` });
    expect(gap.agent).toBeNull();
    await expectOpen(client, w.companyA.id);
    client.ws.close();
  });
});

describe("termination is atomic and retryable (SEC-060)", () => {
  // Fault injection in the real database: while a row named key_revoke
  // exists, revoking an agent key raises inside the same transaction.
  beforeAll(async () => {
    await real.db.execute(sql`create table if not exists test_faults (name text primary key)`);
    await real.db.execute(sql`
      create or replace function test_fail_key_revoke() returns trigger as $$
      begin
        if exists (select 1 from test_faults where name = 'key_revoke') then
          raise exception 'injected key revocation failure';
        end if;
        return new;
      end $$ language plpgsql`);
    await real.db.execute(sql`
      create trigger test_fail_key_revoke before update on agent_api_keys for each row
      when (new.revoked_at is not null and old.revoked_at is null)
      execute function test_fail_key_revoke()`);
  });
  const fault = (on: boolean) =>
    on
      ? real.db.execute(sql`insert into test_faults (name) values ('key_revoke') on conflict do nothing`)
      : real.db.execute(sql`delete from test_faults where name = 'key_revoke'`);
  const agentStatus = (id: string) =>
    real.db.select({ status: agents.status }).from(agents).where(eq(agents.id, id)).then((r) => r[0]!.status);
  const liveKeys = (agentId: string) =>
    real.db
      .select({ revokedAt: agentApiKeys.revokedAt })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.agentId, agentId))
      .then((rows) => rows.filter((row) => row.revokedAt === null).length);

  it("a failed key revocation rolls the termination back; the retry completes it and closes the socket", async () => {
    const w = await seedWorld(real.db);
    const target = await openTagged(w.companyA.id, tokenOf(w).target);
    await fault(true);
    try {
      const failed = await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, { status: "terminated" });
      expect(failed.status).toBe(500);
    } finally {
      await fault(false);
    }
    // Nothing half-committed: the agent is not terminated and keeps its key,
    // so its open socket is consistent with the stored state.
    expect(await agentStatus(w.agentA.id)).toBe("idle");
    expect(await liveKeys(w.agentA.id)).toBe(1);
    await expectOpen(target, w.companyA.id);

    const retried = await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, { status: "terminated" });
    expect(retried.status).toBe(200);
    expect(await agentStatus(w.agentA.id)).toBe("terminated");
    expect(await liveKeys(w.agentA.id)).toBe(0);
    await expectClosed(target);
  });

  it("re-terminating an already terminated agent repairs live keys and sockets left by an older failure", async () => {
    const w = await seedWorld(real.db);
    const target = await openTagged(w.companyA.id, tokenOf(w).target);
    // Partial state as left by pre-fix code: status committed, key live.
    await real.db.update(agents).set({ status: "terminated" }).where(eq(agents.id, w.agentA.id));
    const res = await send(real.app, w.callers.member, "patch", `/api/agents/${w.agentA.id}`, { status: "terminated" });
    expect(res.status).toBe(200);
    expect(await liveKeys(w.agentA.id)).toBe(0);
    await expectClosed(target);
  });

  it("a hire rejection interrupted by a revocation failure is finished by retrying the rejection", async () => {
    const w = await seedWorld(real.db);
    await real.db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, w.agentA.id));
    const approval = await real.db
      .insert(approvals)
      .values({ companyId: w.companyA.id, type: "hire_agent", status: "pending", payload: { agentId: w.agentA.id } })
      .returning()
      .then((r) => r[0]!);
    await fault(true);
    try {
      const failed = await send(real.app, w.callers.member, "post", `/api/approvals/${approval.id}/reject`, {});
      expect(failed.status).toBe(500);
    } finally {
      await fault(false);
    }
    expect(await liveKeys(w.agentA.id)).toBe(1);
    expect(await agentStatus(w.agentA.id)).toBe("pending_approval");

    const retried = await send(real.app, w.callers.member, "post", `/api/approvals/${approval.id}/reject`, {});
    expect(retried.status).toBe(200);
    expect(await agentStatus(w.agentA.id)).toBe("terminated");
    expect(await liveKeys(w.agentA.id)).toBe(0);
  });
});

describe("terminated is terminal under concurrency (SEC-060)", () => {
  // A second app whose database handle runs a hook when the next write
  // transaction starts: after the PATCH route authorized the agent and its
  // service read the old status, before the write. The hook terminates the
  // agent through the real app.
  const gapHook: { fn: null | (() => Promise<void>) } = { fn: null };
  let racingApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "test-only-jwt-secret";
    const proxiedDb = new Proxy(real.db as any, {
      get(target, prop) {
        if (prop === "transaction" && gapHook.fn) {
          return async (...args: unknown[]) => {
            const hook = gapHook.fn;
            gapHook.fn = null;
            if (hook) await hook();
            return target.transaction(...args);
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    racingApp = await buildApp(proxiedDb);
  });

  it("a self-PATCH overlapping termination cannot resurrect the agent or its JWT", async () => {
    const w = await seedWorld(real.db);
    const jwt = createLocalAgentJwt(w.agentA.id, w.companyA.id, "process", w.runA.id);
    expect(jwt).toBeTruthy();
    // Control: the JWT authenticates while the agent is alive.
    expect((await send(real.app, { kind: "agent", token: jwt! }, "get", "/api/agents/me")).status).toBe(200);

    gapHook.fn = async () => {
      const res = await send(real.app, w.callers.member, "post", `/api/agents/${w.agentA.id}/terminate`);
      expect(res.status).toBe(200);
    };
    const patch = await send(racingApp, w.callers.targetAgent, "patch", `/api/agents/${w.agentA.id}`, {
      status: "idle",
      title: "still here",
    });
    expect(gapHook.fn).toBeNull();
    expect(patch.status).toBe(409);
    expect(await real.db.select({ status: agents.status }).from(agents).where(eq(agents.id, w.agentA.id)).then((r) => r[0]!.status)).toBe("terminated");
    expect((await send(real.app, { kind: "agent", token: jwt! }, "get", "/api/agents/me")).status).toBe(401);
  });

  it("pause and resume cannot move a terminated agent", async () => {
    const w = await seedWorld(real.db);
    await real.db.update(agents).set({ status: "terminated" }).where(eq(agents.id, w.agentA.id));
    for (const action of ["pause", "resume"]) {
      const res = await send(real.app, w.callers.member, "post", `/api/agents/${w.agentA.id}/${action}`);
      expect(res.status).toBe(409);
    }
    expect(await real.db.select({ status: agents.status }).from(agents).where(eq(agents.id, w.agentA.id)).then((r) => r[0]!.status)).toBe("terminated");
  });

  it("control: a non-overlapping self-PATCH of a live agent still succeeds", async () => {
    const w = await seedWorld(real.db);
    const res = await send(racingApp, w.callers.targetAgent, "patch", `/api/agents/${w.agentA.id}`, { title: "fine" });
    expect(res.status).toBe(200);
  });
});

describe("board revocation closes live sockets", () => {
  it("logout with a session cookie AND an invalid bearer header closes that session's socket only", async () => {
    const w = await seedWorld(real.db);
    const user = await signUp(w);
    const second = await signIn(user.email);
    const s1 = await openTagged(w.companyA.id, { cookie: user.cookie });
    const s2 = await openTagged(w.companyA.id, { cookie: second });
    const res = await authPost("/api/auth/sign-out", user.cookie, {}, { authorization: "Bearer not-a-real-key" });
    expect(res.status).toBe(200);
    await expectClosed(s1);
    await expectOpen(s2, w.companyA.id);
    await expect(open(w.companyA.id, { cookie: user.cookie })).rejects.toThrow(/upgrade 403/);
    s2.ws.close();
  });

  it("revoke-session closes exactly the revoked session's socket", async () => {
    const w = await seedWorld(real.db);
    const user = await signUp(w);
    const other = await signIn(user.email);
    const target = await openTagged(w.companyA.id, { cookie: other });
    const keeper = await openTagged(w.companyA.id, { cookie: user.cookie });
    const sessions = await sessionTokens(user.cookie);
    const otherToken = sessions.map((x) => x.token).find((t) => other.includes(t));
    expect(otherToken).toBeTruthy();
    const res = await authPost("/api/auth/revoke-session", user.cookie, { token: otherToken });
    expect(res.status).toBe(200);
    await expectClosed(target);
    await expectOpen(keeper, w.companyA.id);
    keeper.ws.close();
  });

  it("revoke-other-sessions closes every other session; the caller's stays", async () => {
    const w = await seedWorld(real.db);
    const user = await signUp(w);
    const a = await signIn(user.email);
    const b = await signIn(user.email);
    const sa = await openTagged(w.companyA.id, { cookie: a });
    const sb = await openTagged(w.companyA.id, { cookie: b });
    const mine = await openTagged(w.companyA.id, { cookie: user.cookie });
    const res = await authPost("/api/auth/revoke-other-sessions", user.cookie);
    expect(res.status).toBe(200);
    await expectClosed(sa);
    await expectClosed(sb);
    await expectOpen(mine, w.companyA.id);
    mine.ws.close();
  });

  it("revoke-sessions (bulk) closes all of the user's sockets and leaves another user's open", async () => {
    const w = await seedWorld(real.db);
    const user = await signUp(w);
    const second = await signIn(user.email);
    const bystander = await signUp(w);
    const s1 = await openTagged(w.companyA.id, { cookie: user.cookie });
    const s2 = await openTagged(w.companyA.id, { cookie: second });
    const control = await openTagged(w.companyA.id, { cookie: bystander.cookie });
    const res = await authPost("/api/auth/revoke-sessions", user.cookie);
    expect(res.status).toBe(200);
    await expectClosed(s1);
    await expectClosed(s2);
    await expectOpen(control, w.companyA.id);
    control.ws.close();
  });

  it("membership removal closes the user's socket and blocks reconnect", async () => {
    const w = await seedWorld(real.db);
    const client = await openTagged(w.companyA.id, { userId: w.users.member });
    await accessService(real.db).setUserCompanyAccess(w.users.member, []);
    await expectClosed(client);
    await expect(open(w.companyA.id, { userId: w.users.member })).rejects.toThrow(/upgrade 403/);
  });

  it("membership suspension closes the user's socket and blocks reconnect", async () => {
    const w = await seedWorld(real.db);
    const client = await openTagged(w.companyA.id, { userId: w.users.member });
    const other = await openTagged(w.companyB.id, { userId: w.users.outsider });
    await accessService(real.db).ensureMembership(w.companyA.id, "user", w.users.member, "member", "suspended");
    await expectClosed(client);
    await expectOpen(other, w.companyB.id);
    await expect(open(w.companyA.id, { userId: w.users.member })).rejects.toThrow(/upgrade 403/);
    other.ws.close();
  });

  it("an outsider cannot open company A's stream", async () => {
    const w = await seedWorld(real.db);
    await expect(open(w.companyA.id, { userId: w.users.outsider })).rejects.toThrow(/upgrade 403/);
  });
});

describe("live events bounded connection lifetime", () => {
  it("closes a connection that outlives the maximum lifetime (one hour)", () => {
    vi.useFakeTimers();
    const fakeServer = new EventEmitter();
    const localWss: any = setupLiveEventsWebSocketServer(fakeServer as any, {} as any, { deploymentMode: "local_trusted" });
    const listeners = new Map<string, Array<() => void>>();
    const socket = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      ping: vi.fn(() => (listeners.get("pong") ?? []).forEach((fn) => fn())),
      on(event: string, fn: () => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
    };
    localWss.emit("connection", socket, {
      paperclipUpgradeContext: { companyId: "c1", actorType: "board", actorId: "u1", userId: "u1", sessionId: "s1" },
      // An upgrade mark later than any revocation: authorized and clean.
      paperclipUpgradeMark: { seq: Number.MAX_SAFE_INTEGER, at: Date.now() },
    });
    localWss.clients.add(socket);

    vi.advanceTimersByTime(60 * 60 * 1000 - 60_000);
    expect(socket.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(90_000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.close.mock.calls[0][0]).toBe(1008);
    publishLiveEvent({ companyId: "c1", type: "heartbeat.run.log" as any });
    expect(socket.send).not.toHaveBeenCalled();

    localWss.close();
    vi.useRealTimers();
  });
});
