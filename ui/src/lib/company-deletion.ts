import type { AuthSession } from "../api/auth";
import type { HealthStatus } from "../api/health";

// SEC-066: mirror the server rule. DELETE /companies/:id is refused unless the
// instance enabled deletion AND the caller is an instance admin.
export function canDeleteCompanies(
  health: HealthStatus | null | undefined,
  session: AuthSession | null | undefined,
): boolean {
  return health?.features?.companyDeletionEnabled === true && session?.user.isInstanceAdmin === true;
}
