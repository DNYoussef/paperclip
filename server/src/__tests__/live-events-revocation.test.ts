import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals } from "@paperclipai/db";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { accessService } from "../services/index.js";
import { publishLiveEvent } from "../services/live-events.js";
import { send, seedWorld, startRealApp, type RealApp, type World } from "./helpers/real-app.js";

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

beforeAll(async () => {
  real = await startRealApp();
  server = createServer(real.app);
  wss = setupLiveEventsWebSocketServer(server, real.db as any, {
    deploymentMode: "authenticated",
    resolveSessionFromHeaders: async (headers: Headers) => {
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

type Who = { token: string } | { userId: string; sessionId?: string };

function open(companyId: string, who: Who): Promise<Client> {
  const headers: Record<string, string> =
    "token" in who
      ? { authorization: `Bearer ${who.token}` }
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

describe("board revocation closes live sockets", () => {
  it("logout closes that session's socket only", async () => {
    const w = await seedWorld(real.db);
    const s1 = await openTagged(w.companyA.id, { userId: w.users.member, sessionId: "s1" });
    const s2 = await openTagged(w.companyA.id, { userId: w.users.member, sessionId: "s2" });
    const res = await send(real.app, { kind: "board", userId: w.users.member, sessionId: "s1" }, "post", "/api/auth/sign-out", {});
    expect(res.status).toBe(200);
    await expectClosed(s1);
    await expectOpen(s2, w.companyA.id);
    s2.ws.close();
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
