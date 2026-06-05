import type { LiveEventType } from "../constants.js";

export interface LiveEvent {
  id: string;
  companyId: string;
  type: LiveEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}
