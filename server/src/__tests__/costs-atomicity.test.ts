import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { costService } from "../services/costs.js";

function rows<T>(r: T[]) { const p = Promise.resolve(r); return { then: p.then.bind(p) }; }

function makeDb() {
  const agent = { id: "agent-1", companyId: "company-1", status: "active",
    budgetMonthlyCents: 100, spentMonthlyCents: 0, updatedAt: new Date() };
  const company = { id: "company-1", budgetMonthlyCents: 10_000, spentMonthlyCents: 0, updatedAt: new Date() };
  const sums = [120, 120]; // agentSum, companySum -> 120 >= agent cap 100 => must pause
  const updates: Array<{ table: string; patch: any }> = [];
  let transactionCalls = 0;
  const mk = (t: unknown) => t === agents ? "agents" : t === companies ? "companies" : "costEvents";
  const db: any = {
    select: () => ({ from: (t: unknown) => ({
      where: () => {
        const r = t === agents ? rows([agent]) : t === companies ? rows([company])
          : rows([{ total: sums.shift() ?? 0 }]);
        return Object.assign(r, { for: () => r }); // .for("update") chains off .where()
      },
    }) }),
    insert: () => ({ values: (v: any) => ({ returning: () => rows([{ id: "event-1", ...v }]) }) }),
    update: (t: unknown) => ({ set: (patch: any) => {
      updates.push({ table: mk(t), patch }); return { where: () => rows([]) }; } }),
    transaction: async (cb: any) => { transactionCalls++; return cb(db); },
  };
  return { db: db as Db, updates, get transactionCalls() { return transactionCalls; } };
}

describe("cost event atomicity", () => {
  it("runs insert + recompute + pause inside a single transaction", async () => {
    const h = makeDb();
    await costService(h.db).createEvent("company-1", {
      agentId: "agent-1", provider: "openai", model: "gpt-4.1",
      inputTokens: 1, outputTokens: 1, costCents: 120,
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
    } as any);
    expect(h.transactionCalls).toBe(1);
    // the over-budget agent must be paused within that same transaction
    expect(h.updates.some((u) => u.table === "agents" && u.patch.status === "paused")).toBe(true);
  });
});
