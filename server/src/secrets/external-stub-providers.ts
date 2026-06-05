import { unprocessable } from "../errors.js";
import type { SecretProviderModule } from "./types.js";

function unavailableProvider(
  id: "aws_secrets_manager" | "gcp_secret_manager" | "vault",
  label: string,
): SecretProviderModule {
  const unavailableReason = `${label} is not shipped in this deployment; use local_encrypted or configure a real provider integration first.`;

  return {
    id,
    descriptor: {
      id,
      label,
      requiresExternalRef: true,
      status: "unavailable",
      selectable: false,
      evidenceStatus: "not_shipped_external_provider",
      unavailableReason,
    },
    async createVersion() {
      throw unprocessable(unavailableReason);
    },
    async resolveVersion() {
      throw unprocessable(unavailableReason);
    },
  };
}

export const awsSecretsManagerProvider = unavailableProvider(
  "aws_secrets_manager",
  "AWS Secrets Manager",
);
export const gcpSecretManagerProvider = unavailableProvider(
  "gcp_secret_manager",
  "GCP Secret Manager",
);
export const vaultProvider = unavailableProvider("vault", "HashiCorp Vault");
