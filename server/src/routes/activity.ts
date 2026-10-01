import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { activityService } from "../services/activity.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  agentService,
  approvalService,
  goalService,
  heartbeatService,
  issueService,
  projectService,
} from "../services/index.js";
import { notFound } from "../errors.js";
import { sanitizeRecord } from "../redaction.js";

// SEC-071: client-reported activity never carries attribution. actorType and
// actorId come from the authenticated actor; authoritative action names
// (approval.*, company.*, agent.*, ...) stay reserved for server-generated
// events, so client events must be namespaced client.*.
const CLIENT_ENTITY_TYPES = ["issue", "agent", "project", "goal", "approval", "company"] as const;

const createActivitySchema = z
  .object({
    action: z.string().regex(/^client\.[a-z0-9_.-]+$/i, "Client activity actions must be namespaced client.*"),
    entityType: z.enum(CLIENT_ENTITY_TYPES),
    entityId: z.string().min(1),
    details: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const issueSvc = issueService(db);
  const agentSvc = agentService(db);
  const projectSvc = projectService(db);
  const goalSvc = goalService(db);
  const approvalSvc = approvalService(db);
  const heartbeat = heartbeatService(db);

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  async function assertEntityInCompany(
    companyId: string,
    entityType: (typeof CLIENT_ENTITY_TYPES)[number],
    entityId: string,
  ) {
    const owner =
      entityType === "company"
        ? entityId === companyId
          ? { companyId }
          : null
        : entityType === "issue"
          ? await issueSvc.getById(entityId)
          : entityType === "agent"
            ? await agentSvc.getById(entityId)
            : entityType === "project"
              ? await projectSvc.getById(entityId)
              : entityType === "goal"
                ? await goalSvc.getById(entityId)
                : await approvalSvc.getById(entityId);
    if (!owner || owner.companyId !== companyId) {
      throw notFound(`${entityType} not found`);
    }
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    await assertEntityInCompany(companyId, req.body.entityType, req.body.entityId);
    const event = await svc.create({
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: req.body.action,
      entityType: req.body.entityType,
      entityId: req.body.entityId,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.forIssue(issue.id);
    res.json(result);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    // SEC-056: authenticate (401) before resolving the run, then scope to its company.
    getActorInfo(req);
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.issuesForRun(runId, run.companyId);
    res.json(result);
  });

  return router;
}
