import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

// Connection registry (SEC-060). Every live-events socket records who opened
// it so that logout, membership removal, agent termination and key revocation
// can close the affected sockets instead of letting them stream forever.
export interface LiveEventsConnectionContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  keyId?: string;
}

export type LiveEventsConnectionFilter = Partial<
  Pick<LiveEventsConnectionContext, "companyId" | "userId" | "sessionId" | "agentId" | "keyId">
>;

interface LiveEventsConnection {
  context: LiveEventsConnectionContext;
  close: (code: number, reason: string) => void;
}

const connections = new Set<LiveEventsConnection>();

export function registerLiveEventsConnection(
  context: LiveEventsConnectionContext,
  close: (code: number, reason: string) => void,
) {
  const entry: LiveEventsConnection = { context, close };
  connections.add(entry);
  return () => {
    connections.delete(entry);
  };
}

// Upgrades in flight (SEC-060). Authorization reads the database before the
// socket is registered, so a revocation landing in that gap would find no
// connection to close. Every revocation is therefore also logged for a short
// window; an upgrade takes a mark before authorizing and is refused at
// registration if a matching revocation happened after its mark.
export const LIVE_EVENTS_UPGRADE_WINDOW_MS = 60_000;
let revocationSeq = 0;
const recentRevocations: Array<{ seq: number; at: number; filter: LiveEventsConnectionFilter }> = [];

export interface LiveEventsUpgradeMark {
  seq: number;
  at: number;
}

export function beginLiveEventsUpgrade(): LiveEventsUpgradeMark {
  return { seq: revocationSeq, at: Date.now() };
}

function matches(filter: LiveEventsConnectionFilter, context: LiveEventsConnectionContext) {
  const keys = (Object.keys(filter) as Array<keyof LiveEventsConnectionFilter>).filter(
    (key) => filter[key] !== undefined,
  );
  return keys.length > 0 && keys.every((key) => context[key] === filter[key]);
}

export function revokedDuringUpgrade(mark: LiveEventsUpgradeMark, context: LiveEventsConnectionContext) {
  // ponytail: an upgrade older than the log window cannot be proven clean;
  // refuse it and let the client reconnect.
  if (Date.now() - mark.at > LIVE_EVENTS_UPGRADE_WINDOW_MS) return true;
  return recentRevocations.some((entry) => entry.seq > mark.seq && matches(entry.filter, context));
}

export function closeLiveEventsConnections(filter: LiveEventsConnectionFilter, reason: string) {
  const keys = (Object.keys(filter) as Array<keyof LiveEventsConnectionFilter>).filter(
    (key) => filter[key] !== undefined,
  );
  if (keys.length === 0) return 0;

  const now = Date.now();
  recentRevocations.push({ seq: ++revocationSeq, at: now, filter: { ...filter } });
  while (recentRevocations.length > 0 && now - recentRevocations[0]!.at > LIVE_EVENTS_UPGRADE_WINDOW_MS) {
    recentRevocations.shift();
  }

  let closed = 0;
  for (const entry of Array.from(connections)) {
    if (!keys.every((key) => entry.context[key] === filter[key])) continue;
    connections.delete(entry);
    closed += 1;
    try {
      entry.close(1008, reason);
    } catch {
      // The socket may already be gone; nothing else to release.
    }
  }
  return closed;
}
