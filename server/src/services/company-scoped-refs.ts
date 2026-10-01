import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, issues, projects } from "@paperclipai/db";
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
