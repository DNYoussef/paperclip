# Railway scripts

## wp16-cutover.sh: move run logs onto a Railway volume at /paperclip

`Dockerfile.railway` runs `docker/railway-entrypoint.sh` as root. It creates
`instances/<id>/data/{run-logs,storage}`, re-owns `/paperclip` to `node`, and
checks as node that each of those dirs is writable. Only then does it drop to
node and start the server. That lets a root-owned Railway volume be mounted
at `/paperclip`.

The script is written for the production shape measured on 2026-10-07:

- only `instances/default/{data/backups, data/run-logs, logs, workspaces (empty)}`
- no config.json, .env, secrets/ or data/storage, and therefore no attachments
- Postgres is external. There is no master key variable or key file and no
  stored secret (measured 2026-10-08), so no key material moves; a key
  created later lands on the volume and persists

`preflight` asserts exactly that shape. If anything differs, it aborts with
"shape changed, re-plan". Do not adapt the script on the fly; re-plan instead.

**Migrated set: `data/run-logs` (318 files, 1.3 MB) and `logs`.**
`data/backups` (about 20 GB of hourly full SQL exports) is left behind on
purpose. Those exports are what WP-16 switches off
(`PAPERCLIP_DB_BACKUP_ENABLED=false`), and Postgres already has daily backups
plus point-in-time recovery. Copying 20 GB of redundant dumps would make the
cutover window long and fragile, with nothing gained.

Run it from Git Bash, one step at a time, with
`SVC=<service> OUT=<private dir outside the repo>`:

| Step | Where | What it proves |
|------|-------|----------------|
| `preflight` | original container | The shape is exact. Effective storage and run-log paths come from the server's own `loadConfig()` and sit under `/paperclip/instances/default`. No agent or project cwd, worktreeParentDir or CODEX_HOME points outside `/paperclip`. Symlinks, if any, point only into `/app`. |
| `record` | local | Saves recent deployments, so the rollback target is known, and variable names (no values). |
| `quiesce` | original | Owner deactivates the n8n workflows that call Paperclip. The step then polls until there are zero queued or running heartbeat runs. |
| `snapshot` | original, still running | Takes the hash inventory and the DB run-log baseline (rows, present, missing). Builds `tar \| base64` and compares the sha256 computed on each end. Checks that every inventoried file is in the archive. |
| `recheck` | original | Right before attach: no runs created since the snapshot, run logs byte-identical, same set of server log files. |
| `attach` | new container | Sets `PAPERCLIP_DB_BACKUP_ENABLED=false`. The owner deploys the WP-16 image FIRST, with no volume, and only then does the step attach the volume, so the old `USER node` image never boots on a root-owned mount. `verify-runtime` runs after that. |
| `restore` | new | Refuses unless the volume holds nothing outside `logs/`. Uploads the archive as base64 in chunks and checks its sha256. Run logs go in place; the old server logs go to `logs/pre-wp16/`, never over the live log. Runs `chown -R -h`, checks that every hash matches, and checks the DB reconciliation: no newly missing run logs compared with the baseline. |
| `probe-plant`, redeploy, `probe-check` | new | The random nonce's content survives a redeploy, every hash still matches, `verify-runtime` passes again, and the step prints `PAPERCLIP_STATE_PERSISTS`. The owner then re-activates the same n8n workflows. |

Restore-only mode needs no flag here. While the n8n heartbeat workflows are
paused, nothing writes run logs, and `recheck`, `restore` and
`probe-check` each re-assert that.

`verify-runtime` is the image-level privilege-drop test. It needs a real
Linux container, so it is a deploy-time check (there is no Docker on the
build machine). It finds the server process by its exact CMD and asserts
that the real, effective, saved and filesystem uid and gid are all node's,
that its groups equal node's groups, and that HOME is `/paperclip`. It also
does a write test as node in `data/run-logs`.

`rollback`: use it on any failure from `attach` onward. Possible loss is
limited to run-log history; Postgres is untouched and no secrets are
stored yet. The previous deployment id comes from `record`. Redeploy it
from the Railway dashboard (the CLI only redeploys the latest). Once the
WP-16 image has booted, the volume is node-owned and the old `USER node`
image can use it. If the WP-16 image never booted, detach the volume first.
The verified archive stays in `OUT` with its sha256.
