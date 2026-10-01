import { randomUUID } from "node:crypto";
import type express from "express";
import request from "supertest";
import {
  agents,
  approvals,
  companies,
  companyMemberships,
  goals,
  heartbeatRuns,
  instanceUserRoles,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import { createApp } from "../../app.js";
import { accessService, agentService } from "../../services/index.js";
import { startTestDb, type TestDb } from "./test-db.js";

// The real application (createApp: actor middleware, mutation guard, every
// router, real services) over a real PostgreSQL. Board users authenticate
// through a header-driven resolveSession; agents through real API keys.
export interface RealApp extends TestDb {
  app: express.Express;
}

export async function startRealApp(opts: { companyDeletionEnabled?: boolean } = {}): Promise<RealApp> {
  const testDb = await startTestDb();
  return { ...testDb, app: await buildApp(testDb.db, opts) };
}

export function buildApp(db: Db, opts: { companyDeletionEnabled?: boolean } = {}) {
  return createApp(db, {
    uiMode: "none",
    serverPort: 0,
    storageService: {} as any,
    deploymentMode: "authenticated",
    deploymentExposure: "public",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: opts.companyDeletionEnabled ?? false,
    betterAuthHandler: (_req, res) => {
      res.json({ ok: true });
    },
    resolveSession: async (req) => {
      const userId = req.header("x-test-user");
      if (!userId) return null;
      const sessionId = req.header("x-test-session") ?? `session-${userId}`;
      return { session: { id: sessionId, userId }, user: { id: userId, email: null, name: null } } as any;
    },
  });
}

export type Caller =
  | { kind: "anonymous" }
  | { kind: "board"; userId: string; sessionId?: string }
  | { kind: "agent"; token: string };

export function send(
  app: express.Express,
  caller: Caller,
  method: "get" | "post" | "patch" | "delete",
  path: string,
  body?: unknown,
) {
  let req = request(app)[method](path);
  if (caller.kind === "board") {
    req = req.set("x-test-user", caller.userId).set("origin", "http://localhost:3100");
    if (caller.sessionId) req = req.set("x-test-session", caller.sessionId);
  }
  if (caller.kind === "agent") req = req.set("authorization", `Bearer ${caller.token}`);
  return body === undefined ? req : req.send(body as object);
}

function prefix() {
  return `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

async function insertCompany(db: Db, name: string) {
  return db
    .insert(companies)
    .values({ name, issuePrefix: prefix() })
    .returning()
    .then((rows) => rows[0]!);
}

async function insertAgent(db: Db, companyId: string, name: string, extra: Partial<typeof agents.$inferInsert> = {}) {
  return db
    .insert(agents)
    .values({ companyId, name, status: "idle", budgetMonthlyCents: 100, ...extra })
    .returning()
    .then((rows) => rows[0]!);
}

async function join(db: Db, companyId: string, userId: string) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "member",
  });
}

// Two companies, A (the target) and B (the outsider's), with every principal
// the authorization tests need. Former and suspended members are produced by
// the real revocation operations, not by hand-built actor objects.
export async function seedWorld(db: Db) {
  const access = accessService(db);
  const agentSvc = agentService(db);
  const tag = randomUUID().slice(0, 8);
  const companyA = await insertCompany(db, `A ${tag}`);
  const companyB = await insertCompany(db, `B ${tag}`);

  const users = {
    member: `member-${tag}`,
    outsider: `outsider-${tag}`,
    former: `former-${tag}`,
    suspended: `suspended-${tag}`,
    admin: `admin-${tag}`,
  };
  await join(db, companyA.id, users.member);
  await join(db, companyB.id, users.outsider);
  await join(db, companyA.id, users.former);
  await access.setUserCompanyAccess(users.former, []);
  await join(db, companyA.id, users.suspended);
  await access.ensureMembership(companyA.id, "user", users.suspended, "member", "suspended");
  await db.insert(instanceUserRoles).values({ userId: users.admin, role: "instance_admin" });

  const agentA = await insertAgent(db, companyA.id, `target ${tag}`);
  const peerA = await insertAgent(db, companyA.id, `peer ${tag}`);
  const agentB = await insertAgent(db, companyB.id, `foreign ${tag}`);
  const keyA = await agentSvc.createApiKey(agentA.id, "target");
  const keyPeerA = await agentSvc.createApiKey(peerA.id, "peer");
  const keyB = await agentSvc.createApiKey(agentB.id, "foreign");

  const runA = await db
    .insert(heartbeatRuns)
    .values({ companyId: companyA.id, agentId: agentA.id, status: "running" })
    .returning()
    .then((rows) => rows[0]!);
  const approvalA = await db
    .insert(approvals)
    .values({ companyId: companyA.id, type: "approve_ceo_strategy", status: "pending", payload: { plan: "private" } })
    .returning()
    .then((rows) => rows[0]!);

  const goalA = await db.insert(goals).values({ companyId: companyA.id, title: `goal A ${tag}` }).returning().then((r) => r[0]!);
  const goalB = await db.insert(goals).values({ companyId: companyB.id, title: `goal B secret ${tag}` }).returning().then((r) => r[0]!);
  const projectA = await db.insert(projects).values({ companyId: companyA.id, name: `project A ${tag}` }).returning().then((r) => r[0]!);
  const projectB = await db
    .insert(projects)
    .values({ companyId: companyB.id, name: `project B secret ${tag}`, description: "foreign description" })
    .returning()
    .then((r) => r[0]!);
  const issueA = await db.insert(issues).values({ companyId: companyA.id, title: `issue A ${tag}` }).returning().then((r) => r[0]!);
  const issueB = await db.insert(issues).values({ companyId: companyB.id, title: `issue B secret ${tag}` }).returning().then((r) => r[0]!);

  const callers = {
    anonymous: { kind: "anonymous" } as Caller,
    member: { kind: "board", userId: users.member } as Caller,
    outsider: { kind: "board", userId: users.outsider } as Caller,
    formerMember: { kind: "board", userId: users.former } as Caller,
    suspendedMember: { kind: "board", userId: users.suspended } as Caller,
    instanceAdmin: { kind: "board", userId: users.admin } as Caller,
    foreignAgent: { kind: "agent", token: keyB.token } as Caller,
    targetAgent: { kind: "agent", token: keyA.token } as Caller,
    peerAgent: { kind: "agent", token: keyPeerA.token } as Caller,
  };

  return {
    companyA,
    companyB,
    users,
    agentA,
    peerA,
    agentB,
    keyA,
    keyPeerA,
    keyB,
    runA,
    approvalA,
    goalA,
    goalB,
    projectA,
    projectB,
    issueA,
    issueB,
    callers,
  };
}

export type World = Awaited<ReturnType<typeof seedWorld>>;
