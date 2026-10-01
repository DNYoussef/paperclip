import express, { type Router } from "express";
import { errorHandler } from "../../middleware/index.js";

export const COMPANY = "company-1";
export const OTHER_COMPANY = "company-other";

export const ACTORS = {
  anonymous: { type: "none", source: "none" },
  outsider: {
    type: "board",
    userId: "outsider-user",
    companyIds: [OTHER_COMPANY],
    source: "session",
    isInstanceAdmin: false,
  },
  formerMember: {
    type: "board",
    userId: "former-user",
    companyIds: [],
    source: "session",
    isInstanceAdmin: false,
  },
  foreignAgent: {
    type: "agent",
    agentId: "agent-other",
    companyId: OTHER_COMPANY,
    keyId: "key-other",
    source: "agent_key",
  },
  member: {
    type: "board",
    userId: "member-user",
    companyIds: [COMPANY],
    source: "session",
    isInstanceAdmin: false,
  },
  instanceAdmin: {
    type: "board",
    userId: "admin-user",
    companyIds: [],
    source: "session",
    isInstanceAdmin: true,
  },
} as const;

export type ActorName = keyof typeof ACTORS;

export function appWithActor(actor: (typeof ACTORS)[ActorName], mount: Router, prefix = "/api") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use(prefix, mount);
  app.use(errorHandler);
  return app;
}
