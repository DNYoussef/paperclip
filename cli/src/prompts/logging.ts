import * as p from "@clack/prompts";
import type { LoggingConfig } from "../config/schema.js";
import { resolveDefaultLogsDir, resolvePaperclipInstanceId } from "../config/home.js";

export const LOGGING_MODE_OPTIONS = [
  { value: "file" as const, label: "File-based logging", hint: "recommended" },
];

export async function promptLogging(): Promise<LoggingConfig> {
  const defaultLogDir = resolveDefaultLogsDir(resolvePaperclipInstanceId());
  const mode = await p.select({
    message: "Logging mode",
    options: LOGGING_MODE_OPTIONS,
  });

  if (p.isCancel(mode)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const logDir = await p.text({
    message: "Log directory",
    defaultValue: defaultLogDir,
    placeholder: defaultLogDir,
  });

  if (p.isCancel(logDir)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return { mode: "file", logDir: logDir || defaultLogDir };
}
