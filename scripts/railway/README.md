# Railway scripts

## Sign-up policy and owner recovery

Sign-up is closed on Railway for every provider (email/password and Google).
`Dockerfile.railway` sets `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, and when the
variable is unset the server still closes sign-up whenever Railway's
`RAILWAY_ENVIRONMENT_ID` or `RAILWAY_ENVIRONMENT_NAME` is present, so the
policy does not depend on which Dockerfile built the image. The variable takes
exactly `true` or `false`; any other value (`1`, `TRUE`, `true `, empty)
stops the server at startup. Each boot logs `authDisableSignUp` in the
"Authenticated mode auth origin configuration" line.

Existing users sign in as before. A first Google sign-in links to an existing
user with the same verified email, so a forgotten password is recovered by
signing in with Google.

Owner recovery (full lockout, or a new instance admin) never reopens sign-up
and does not need the service stopped. It runs as one database transaction
that holds and increments a credential epoch
(`server/src/auth/credential-epoch.ts`). Every auth request records the epoch
when it enters, and every session or account write the server makes is
conditional on it inside its own transaction, so a login, password change or
Google link that was already in flight when recovery ran is refused before
anything it writes becomes visible. Recoveries are serialized by the same
lock. Logins in flight at that moment fail and can be retried.

1. `railway ssh --service <paperclip>`, then from `/app`:
   `node --import ./server/node_modules/tsx/dist/loader.mjs server/src/auth/recover-admin.ts <email>`
   For an existing user it deletes every credential (password and linked
   Google) and every session, sets a fresh random password, and grants
   instance admin; the user row, its history and memberships stay. For an
   unknown email it creates the user with that password and grants instance
   admin. It prints the one-time password once. Instance admins see and
   manage every company.
2. Restart the paperclip service, so live-event streams opened with the
   deleted sessions close.
3. Sign in with the email and the printed password. To rotate it, run the
   tool again.

If the tool is interrupted, its transaction rolls back and nothing changes;
run it again.

Do not reopen sign-up to recover. `PAPERCLIP_AUTH_DISABLE_SIGN_UP=false` opens
registration to anyone who can reach the server, for any email: an attacker
can register an admin's address with their own password, and that admin's
later Google sign-in links to the attacker's account. If sign-up was ever
open, run the recovery tool for every admin email afterwards, and review the
`user` table for accounts nobody expected. Invited people cannot register
while sign-up is closed; create them with the tool or reopen deliberately for
the shortest possible window.

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
| `quiesce` | original | Heartbeat runs come from Paperclip's own timer, not n8n (measured 2026-10-08: 4-5 runs every 2 hours at even ET hours, around :35). Start right after a batch has finished, so that snapshot, recheck and the image deploy finish before the next one. The step polls until there are zero queued or running heartbeat runs. |
| `snapshot` | original, still running | Takes the hash inventory and the DB run-log baseline (rows, present, missing). Builds `tar \| base64` and compares the sha256 computed on each end. Checks that every inventoried file is in the archive. |
| `recheck` | original | Right before attach: no runs created since the snapshot, run logs byte-identical, same set of server log files. |
| `attach` | new container | Sets `PAPERCLIP_DB_BACKUP_ENABLED=false` and `HEARTBEAT_SCHEDULER_ENABLED=false` (the new container runs no heartbeats until `resume`). The owner deploys the WP-16 image FIRST, with no volume, and only then does the step attach the volume, so the old `USER node` image never boots on a root-owned mount. `verify-runtime` runs after that. |
| `restore` | new | Refuses unless the volume holds nothing outside `logs/`. Uploads the archive as base64 in chunks and checks its sha256. Run logs go in place; the old server logs go to `logs/pre-wp16/`, never over the live log. Runs `chown -R -h`, checks that every hash matches, and checks the DB reconciliation: no newly missing run logs compared with the baseline. |
| `probe-plant`, redeploy, `probe-check` | new | The random nonce's content survives a redeploy, every hash still matches, `verify-runtime` passes again, and the step prints `PAPERCLIP_STATE_PERSISTS`. |
| `resume` | new | Deletes `HEARTBEAT_SCHEDULER_ENABLED` (it was unset before), waits for the redeploy, runs `verify-runtime`. Overdue agents run at boot. |

Restore-only mode: on the new container the scheduler is off from `attach`
until `resume`, so nothing writes run logs, and `restore` and `probe-check`
re-assert that. On the old container, a timer run after `recheck` would be
lost; `restore`'s DB reconciliation reports it as a newly missing run log.

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
