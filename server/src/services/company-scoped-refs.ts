import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals, issues, projects } from "@paperclipai/db";
import { notFound } from "../errors.js";

// SEC-062: relationship ids supplied by a caller must resolve inside the
// owning company. A foreign id is indistinguishable from a missing one (404).

export async function assertIssueRefsInCompany(
  db: Db,
  companyId: string,
  refs: { projectId?: string | null; goalId?: string | null; parentId?: string | null },
) {
  if (refs.projectId) {
    const row = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, refs.projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Project not found");
  }
  if (refs.goalId) {
    const row = await db
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.id, refs.goalId), eq(goals.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Goal not found");
  }
  if (refs.parentId) {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, refs.parentId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Parent issue not found");
  }
}

export async function assertGoalsInCompany(db: Db, companyId: string, goalIds: string[]) {
  const unique = Array.from(new Set(goalIds));
  if (unique.length === 0) return;
  const rows = await db
    .select({ id: goals.id })
    .from(goals)
    .where(and(inArray(goals.id, unique), eq(goals.companyId, companyId)));
  if (rows.length !== unique.length) throw notFound("Goal not found");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Agent ids named by a record (approval payload target, requester) must belong
// to that record's company before any side effect runs on them.
export async function assertAgentsInCompany(
  db: Db,
  companyId: string,
  agentIds: Array<string | null | undefined>,
) {
  const unique = Array.from(
    new Set(agentIds.filter((id): id is string => typeof id === "string" && id.length > 0)),
  );
  if (unique.length === 0) return;
  if (unique.some((id) => !UUID_RE.test(id))) throw notFound("Agent not found");
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, unique), eq(agents.companyId, companyId)));
  if (rows.length !== unique.length) throw notFound("Agent not found");
}
