import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

// SEC-058: the deciding user is derived from the authenticated actor, never
// from the body. strict() rejects any body that still carries decidedByUserId.
export const resolveApprovalSchema = z
  .object({
    decisionNote: z.string().optional().nullable(),
  })
  .strict();

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z
  .object({
    decisionNote: z.string().optional().nullable(),
  })
  .strict();

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: z.string().min(1),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
