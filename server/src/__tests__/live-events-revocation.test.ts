import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_EVENTS_MAX_CONNECTION_MS,
  setupLiveEventsWebSocketServer,
} from "../realtime/live-events-ws.js";
import { closeLiveEventsConnections, publishLiveEvent } from "../services/live-events.js";

// SEC-060: a connected live-events client must stop receiving events once its
// session, membership, agent or API key is revoked, and connections must not
// live forever.

function fakeSocket() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    ping: vi.fn(() => {
      for (const fn of listeners.get("pong") ?? []) fn();
    }),
    on(event: string, fn: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
  };
  return socket;
}

interface Context {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  userId?: string;
  sessionId?: string;
  keyId?: string;
  agentId?: string;
}

function connect(wss: any, context: Context) {
  const socket = fakeSocket();
  wss.emit("connection", socket, { paperclipUpgradeContext: context });
  return socket;
}

describe("live events revocation", () => {
  let wss: any;

  beforeEach(() => {
    const server = new EventEmitter();
    wss = setupLiveEventsWebSocketServer(server as any, {} as any, { deploymentMode: "local_trusted" });
  });

  afterEach(() => {
    // Fake sockets never emit "close", so drain the module-level registry.
    closeLiveEventsConnections({ companyId: "c1" }, "test teardown");
    closeLiveEventsConnections({ companyId: "c2" }, "test teardown");
    wss.close();
    vi.useRealTimers();
  });

  it("delivers events while authorized", () => {
    const socket = connect(wss, { companyId: "c1", actorType: "board", actorId: "u1", userId: "u1", sessionId: "s1" });
    publishLiveEvent({ companyId: "c1", type: "heartbeat.run.log" as any, payload: { chunk: "x" } });
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it("logout closes the session's sockets with 1008 and stops delivery", () => {
    const socket = connect(wss, { companyId: "c1", actorType: "board", actorId: "u1", userId: "u1", sessionId: "s1" });
    const other = connect(wss, { companyId: "c1", actorType: "board", actorId: "u2", userId: "u2", sessionId: "s2" });

    const closed = closeLiveEventsConnections({ sessionId: "s1" }, "logout");
    expect(closed).toBe(1);
    expect(socket.close).toHaveBeenCalledWith(1008, "logout");
    expect(other.close).not.toHaveBeenCalled();

    publishLiveEvent({ companyId: "c1", type: "heartbeat.run.log" as any, payload: { chunk: "after" } });
    expect(socket.send).not.toHaveBeenCalled();
    expect(other.send).toHaveBeenCalledTimes(1);
  });

  it("membership removal closes only that user's sockets for that company", () => {
    const removed = connect(wss, { companyId: "c1", actorType: "board", actorId: "u1", userId: "u1", sessionId: "s1" });
    const sameUserOtherCompany = connect(wss, { companyId: "c2", actorType: "board", actorId: "u1", userId: "u1", sessionId: "s1" });

    closeLiveEventsConnections({ userId: "u1", companyId: "c1" }, "membership removed");
    expect(removed.close).toHaveBeenCalledWith(1008, "membership removed");
    expect(sameUserOtherCompany.close).not.toHaveBeenCalled();
  });

  it("agent termination closes the agent's sockets", () => {
    const socket = connect(wss, { companyId: "c1", actorType: "agent", actorId: "a1", agentId: "a1", keyId: "k1" });
    closeLiveEventsConnections({ agentId: "a1" }, "agent terminated");
    expect(socket.close).toHaveBeenCalledWith(1008, "agent terminated");
    publishLiveEvent({ companyId: "c1", type: "heartbeat.run.log" as any });
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("key revocation closes only sockets opened with that key", () => {
    const revoked = connect(wss, { companyId: "c1", actorType: "agent", actorId: "a1", agentId: "a1", keyId: "k1" });
    const kept = connect(wss, { companyId: "c1", actorType: "agent", actorId: "a1", agentId: "a1", keyId: "k2" });
    closeLiveEventsConnections({ keyId: "k1" }, "key revoked");
    expect(revoked.close).toHaveBeenCalledWith(1008, "key revoked");
    expect(kept.close).not.toHaveBeenCalled();
  });

  it("an empty filter closes nothing", () => {
    const socket = connect(wss, { companyId: "c1", actorType: "board", actorId: "u1", userId: "u1" });
    expect(closeLiveEventsConnections({}, "noop")).toBe(0);
    expect(socket.close).not.toHaveBeenCalled();
  });
});

describe("live events bounded connection lifetime", () => {
  it("closes a connection that outlives the maximum lifetime", () => {
    vi.useFakeTimers();
    const server = new EventEmitter();
    const wss: any = setupLiveEventsWebSocketServer(server as any, {} as any, { deploymentMode: "local_trusted" });
    const socket = connect(wss, { companyId: "c1", actorType: "board", actorId: "u1", userId: "u1", sessionId: "s1" });
    wss.clients.add(socket);

    vi.advanceTimersByTime(LIVE_EVENTS_MAX_CONNECTION_MS - 60_000);
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(90_000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.close.mock.calls[0][0]).toBe(1008);

    publishLiveEvent({ companyId: "c1", type: "heartbeat.run.log" as any });
    expect(socket.send).not.toHaveBeenCalled();

    wss.close();
    vi.useRealTimers();
  });
});
