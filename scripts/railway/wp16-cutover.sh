#!/usr/bin/env bash
# WP-16 cutover: put Paperclip's run logs on a Railway volume at /paperclip.
#
# Written for the shape measured on 2026-10-07 and nothing else. Preflight
# asserts that shape and aborts with "shape changed, re-plan" if it differs.
#   /paperclip/instances/default/{data/{backups,run-logs},logs,workspaces(dirs only)}
#   no config.json, .env, secrets/ or data/storage; Postgres external; no
#   master key variable or file and no stored secrets (measured 2026-10-08).
# Migrated set: data/run-logs, logs and the empty workspaces dirs. data/backups is NOT migrated (see
# README). Run from Git Bash, one step at a time, in the order of `help`.
#
# Never prints environment values: remote steps print verdicts, counts,
# booleans and paths only; archive data goes to files, never the terminal.
#
#   SVC=<service> OUT=<private local dir outside the repo> wp16-cutover.sh <step>
set -euo pipefail
export MSYS_NO_PATHCONV=1

SVC="${SVC:?set SVC to the Railway service name}"
OUT="${OUT:?set OUT to a private local directory outside the repo}"
I=/paperclip/instances/default
mkdir -p "$OUT"

say() { printf '%s\n' "$*"; }
die() { printf 'WP16_FAIL: %s\n' "$*" >&2; exit 1; }
confirm() {
  printf '\nOWNER STEP: %s\nType yes when done: ' "$1"
  local a; read -r a < /dev/tty
  [ "$a" = yes ] || die "owner step not confirmed"
}

# remote <step> <outfile>, remote POSIX sh script on stdin.
# The script travels as base64 arguments (no quoting across the ssh hop, no
# stdin forwarding). railway ssh silently drops a command line over about
# 8 KiB (measured 2026-10-08: 8101 chars arrive, 8301 do not), so the base64
# goes up in 6000-char pieces and its sha256 is checked before it runs.
# The step writes to a file that is then cat'ed: node's process.exit() drops
# buffered output written straight to the ssh tty (measured 2026-10-08:
# 8129 of 12000 lines arrived; via a file all 40000 did, in order).
# A step counts as done only if its last output line is
# "WP16_REMOTE_OK <step>". CRs from a pty are stripped.
remote() {
  local step="$1" out="$2" b64 h i=0 d
  # Private dir per invocation: an overlapping call cannot swap the script.
  d="/tmp/wp16-step-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  b64="$( { printf 'set -eu\ndie() { echo "WP16_ERR $*"; exit 1; }\n'; cat; printf '\necho "WP16_REMOTE_OK %s"\n' "$step"; } | base64 -w0)"
  h="$(printf '%s' "$b64" | sha256sum | cut -d' ' -f1)"
  railway ssh -s "$SVC" -- "umask 077 && mkdir $d" > /dev/null 2> "$out.err" || die "railway ssh failed in step $step (stderr in $out.err)"
  while [ "$i" -lt "${#b64}" ]; do
    railway ssh -s "$SVC" -- "printf %s ${b64:i:6000} >> $d/s.b64" > /dev/null 2> "$out.err" \
      || die "upload failed in step $step (stderr in $out.err)"
    i=$((i + 6000))
  done
  if ! railway ssh -s "$SVC" -- "echo '$h  $d/s.b64' | sha256sum -c --status || { echo 'WP16_ERR uploaded step script hash mismatch'; exit 1; }; base64 -d $d/s.b64 > $d/s.sh && sh $d/s.sh; r=\$?; rm -rf $d; exit \$r" > "$out.raw" 2> "$out.err"; then
    tr -d '\r' < "$out.raw" | grep -E '^WP16_(ERR|WARN)' >&2 || true
    die "railway ssh failed in step $step (stderr in $out.err)"
  fi
  tr -d '\r' < "$out.raw" > "$out"; rm -f "$out.raw"
  grep -E '^WP16_(ERR|WARN|INFO)' "$out" || true
  [ "$(tail -n 1 "$out")" = "WP16_REMOTE_OK $step" ] || die "remote step $step did not complete"
}
block() { # block <NAME> <file> -> lines between WP16_<NAME>_BEGIN/END
  sed -n "/^WP16_$1_BEGIN\$/,/^WP16_$1_END\$/p" "$2" | sed '1d;$d'
}

# ---- remote building blocks (POSIX sh, sent inside remote scripts) ----

# Read-only DB helper: node /tmp/wp16-db.cjs <mode> [arg]; uses the server's own
# postgres client and a READ ONLY transaction.
db_sh() {
  cat <<'EOF'
cat > /tmp/wp16-db.cjs <<'JS'
const postgres = require(require.resolve("postgres", { paths: ["/app/packages/db"] }));
const fs = require("fs"), path = require("path");
if (!process.env.DATABASE_URL) { console.log("WP16_ERR DATABASE_URL not set; shape changed, re-plan"); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const [mode, arg] = process.argv.slice(2);
const inside = (p) => p === "/paperclip" || p.startsWith("/paperclip/");
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const run = async (s) => {
  if (mode === "quiesce") {
    if (arg !== undefined && !ISO_TS.test(arg)) throw new Error("since-ts is not an ISO UTC timestamp");
    const [r] = await s`select
      (select count(*)::int from heartbeat_runs where status in ('queued','running')) as live,
      (select count(*)::int from heartbeat_runs where ${arg || null}::timestamptz is not null and created_at > ${arg || null}::timestamptz) as since,
      to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`;
    console.log(`WP16_INFO live_runs=${r.live} runs_created_since=${arg ? r.since : "n/a"}`);
    console.log(`WP16_DBNOW ${r.now}`);
    return r.live === 0 && (!arg || r.since === 0);
  }
  if (mode === "writes") {
    // Secrets and uploads land on the container disk (key file, data/storage),
    // and nothing can block the API during cutover. Any created after the
    // snapshot may have been written to a disk that was then replaced.
    if (!ISO_TS.test(arg || "")) throw new Error("since-ts is not an ISO UTC timestamp");
    const [r] = await s`select
      (select count(*)::int from company_secret_versions where created_at > ${arg}::timestamptz) as secrets,
      (select count(*)::int from assets where created_at > ${arg}::timestamptz) as assets,
      (select count(*)::int from issue_attachments where created_at > ${arg}::timestamptz) as attachments`;
    console.log(`WP16_INFO created_since_snapshot secrets=${r.secrets} assets=${r.assets} attachments=${r.attachments}`);
    if (r.secrets + r.assets + r.attachments > 0) console.log("WP16_ERR secrets or uploads created during cutover may be lost; check them before resume");
    return r.secrets + r.assets + r.attachments === 0;
  }
  if (mode === "runlogs") {
    const rows = await s`select log_ref from heartbeat_runs where log_store = 'local_file' and log_ref is not null`;
    const missing = rows.filter((r) => !fs.existsSync(path.resolve(arg, r.log_ref)));
    console.log(`WP16_INFO runlog_rows=${rows.length} present=${rows.length - missing.length} missing=${missing.length}`);
    console.log("WP16_MISS_BEGIN"); for (const r of missing) console.log(r.log_ref); console.log("WP16_MISS_END");
    return true;
  }
  if (mode === "paths") {
    const rows = await s`
      select 'agent-cwd ' || id as k, adapter_config->>'cwd' as p from agents where adapter_config ? 'cwd'
      union all select 'agent-worktree ' || id, adapter_config#>>'{workspaceStrategy,worktreeParentDir}' from agents
        where adapter_config#>>'{workspaceStrategy,worktreeParentDir}' is not null
      union all select 'agent-codex-home ' || id, coalesce(adapter_config#>>'{env,CODEX_HOME,value}', adapter_config#>>'{env,CODEX_HOME}') from agents
        where adapter_config#>'{env,CODEX_HOME}' is not null
      union all select 'project-workspace ' || id, cwd from project_workspaces where cwd is not null
      union all select 'runtime-service ' || id, cwd from workspace_runtime_services where cwd is not null
      union all select 'project-worktree ' || id, execution_workspace_policy#>>'{workspaceStrategy,worktreeParentDir}' from projects
        where execution_workspace_policy#>>'{workspaceStrategy,worktreeParentDir}' is not null`;
    let bad = 0;
    for (const { k, p } of rows) {
      const ok = p.startsWith("/") ? inside(path.resolve(p)) : !p.split("/").includes("..");
      if (!ok) { bad++; console.log(`WP16_ERR ${k} points outside /paperclip; shape changed, re-plan`); }
    }
    console.log(`WP16_INFO path_overrides=${rows.length} outside=${bad}`);
    // No master key variable and no key file (measured 2026-10-08): stored
    // secrets would have no key to decrypt with, so there must be none.
    const [sv] = await s`select count(*)::int as n from company_secret_versions`;
    console.log(`WP16_INFO secret_versions=${sv.n} master_key_variable=${Boolean(process.env.PAPERCLIP_SECRETS_MASTER_KEY)}`);
    if (sv.n > 0 && !process.env.PAPERCLIP_SECRETS_MASTER_KEY) { bad++; console.log("WP16_ERR secrets stored without a master key variable; shape changed, re-plan"); }
    return bad === 0;
  }
  throw new Error("unknown mode");
};
sql.begin("read only", run)
  .then(async (ok) => { await sql.end(); process.exit(ok ? 0 : 3); })
  .catch((e) => { console.log("WP16_ERR db query failed: " + e.message); process.exit(1); });
JS
cd /app
EOF
}

# Exact-listing assertion for the original container.
shape_sh() {
  cat <<'EOF'
I=/paperclip/instances/default
want_ls() {
  LC_ALL=C ls -A "$1" > /tmp/wp16-ls || die "cannot list $1; shape changed, re-plan"
  got="$(tr '\n' ' ' < /tmp/wp16-ls)"
  [ "$got" = "${2:+$2 }" ] || die "shape changed, re-plan: $1 holds [$got], expected [$2]"
}
want_ls /paperclip instances
want_ls /paperclip/instances default
want_ls "$I" "data logs workspaces"
want_ls "$I/data" "backups run-logs"
# Agent workspace dirs (one per agent id, created by the server) may exist but
# must hold no files: only directories are carried across.
find "$I/workspaces" -mindepth 1 ! -type d > /tmp/wp16-ws || die "find failed"
[ ! -s /tmp/wp16-ws ] || die "shape changed, re-plan: workspaces holds files"
find /paperclip -name '.*' ! -path "$I/data/backups/*" > /tmp/wp16-hidden || die "find failed"
[ ! -s /tmp/wp16-hidden ] || die "shape changed, re-plan: hidden files present"
find "$I/data/run-logs" "$I/logs" ! -type f ! -type d > /tmp/wp16-odd || die "find failed"
[ ! -s /tmp/wp16-odd ] || die "shape changed, re-plan: non-regular entries in the migrated set"
find /paperclip -type l > /tmp/wp16-links || die "find failed"
while IFS= read -r l; do
  t="$(readlink -f "$l")" || die "dangling symlink $l"
  case "$t" in /app/*) ;; *) die "shape changed, re-plan: symlink $l leaves /app" ;; esac
done < /tmp/wp16-links
echo "WP16_INFO shape matches the 2026-10-07 measurement"
EOF
}

# Effective paths through the server's own config loader, with the live env.
config_sh() {
  cat <<'EOF'
cat > /tmp/wp16-cfg.mjs <<'JS'
const { loadConfig } = await import("/app/server/src/config.ts");
const hp = await import("/app/server/src/home-paths.ts");
const path = await import("node:path");
const fs = await import("node:fs");
const c = loadConfig();
const root = "/paperclip/instances/default";
const runLogBase = process.env.RUN_LOG_BASE_PATH ?? path.resolve(hp.resolvePaperclipInstanceRoot(), "data", "run-logs");
const checks = [
  ["storage provider is local_disk", c.storageProvider === "local_disk"],
  ["storage dir is " + root + "/data/storage", c.storageLocalDiskBaseDir === root + "/data/storage"],
  ["run-log base is " + root + "/data/run-logs", runLogBase === root + "/data/run-logs"],
  ["no master key file", !fs.existsSync(c.secretsMasterKeyFilePath)],
  ["master key path is " + root + "/secrets/master.key", c.secretsMasterKeyFilePath === root + "/secrets/master.key"],
  ["external database", Boolean(process.env.DATABASE_URL)],
  ["CODEX_HOME unset or under /paperclip", !process.env.CODEX_HOME || path.resolve(process.env.CODEX_HOME).startsWith("/paperclip/")],
];
let bad = 0;
for (const [label, ok] of checks) { console.log(`WP16_INFO config ${ok ? "ok" : "MISMATCH"}: ${label}`); if (!ok) bad++; }
console.log(`WP16_INFO db backup enabled=${c.databaseBackupEnabled} heartbeat scheduler enabled=${c.heartbeatSchedulerEnabled}`);
if (bad) { console.log("WP16_ERR effective config differs; shape changed, re-plan"); process.exit(1); }
JS
cd /app
node --import ./server/node_modules/tsx/dist/loader.mjs /tmp/wp16-cfg.mjs || die "effective config check failed"
EOF
}

# Hash inventory of the migrated set, paths relative to /.
inventory_sh() {
  cat <<'EOF'
cd /
find paperclip/instances/default/data/run-logs paperclip/instances/default/logs -type f > /tmp/wp16-files || die "find failed"
: > /tmp/wp16-inv
while IFS= read -r f; do sha256sum "$f" >> /tmp/wp16-inv || die "hash failed: $f"; done < /tmp/wp16-files
LC_ALL=C sort -k2 /tmp/wp16-inv > /tmp/wp16-inv.sorted
echo "WP16_INV_BEGIN"; cat /tmp/wp16-inv.sorted; echo "WP16_INV_END"
EOF
}

# ---------------------------------------------------------------- steps

step_transport() {
  local n; n="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'echo "WP16_INFO echo %s"\necho "WP16_INFO uid $(id -u)"\n' "$n" | remote transport "$OUT/transport.txt"
  grep -qx "WP16_INFO echo $n" "$OUT/transport.txt" || die "ssh round trip lost the nonce"
}

step_preflight() { # read-only, original container
  step_transport
  { shape_sh; config_sh; db_sh; echo 'node /tmp/wp16-db.cjs paths || die "path overrides leave /paperclip"'; } \
    | remote preflight "$OUT/preflight.txt"
  say "preflight passed"
}

step_record() { # rollback facts; variable NAMES only (values pass through cut, never stored)
  railway deployment list -s "$SVC" --limit 5 --json > "$OUT/deployments-before.json"
  railway variable list -s "$SVC" --kv | cut -d= -f1 | LC_ALL=C sort > "$OUT/variable-names-before.txt"
  [ -s "$OUT/variable-names-before.txt" ] || die "no variable names recorded"
  say "recorded. Rollback target = the newest deployment in $OUT/deployments-before.json; note its id now:"
  sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$OUT/deployments-before.json" | head -n 1
}

ISO_TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
snap_ts() { # the snapshot's DB time; the regex admits no quote or space
  local t; t="$(cat "$OUT/snapshot-db-time.txt")" || die "no snapshot time"
  [[ "$t" =~ $ISO_TS_RE ]] || die "snapshot time is not an ISO UTC timestamp"
  printf '%s' "$t"
}
quiesce_once() { # quiesce_once <outfile> [since-ts]; since-ts travels as ONE quoted argument
  local since=""
  if [ -n "${2:-}" ]; then
    [[ "$2" =~ $ISO_TS_RE ]] || die "since-ts is not an ISO UTC timestamp"
    since=" '$2'"   # safe to single-quote: the regex admits no quote or space
  fi
  { db_sh; printf 'node /tmp/wp16-db.cjs quiesce%s || die "not quiesced"\n' "$since"; } | remote quiesce "$1"
}

step_quiesce() {
  confirm "Heartbeat runs come from Paperclip's own timer (even ET hours, ~:35). Confirm the last batch has finished and snapshot, recheck and the image deploy will finish before the next one."
  local i
  for i in $(seq 1 60); do
    if (quiesce_once "$OUT/quiesce.txt") 2>/dev/null; then say "quiesced: zero queued or running heartbeat runs"; return 0; fi
    sleep 10
  done
  die "runs still live after 10 minutes (see $OUT/quiesce.txt)"
}

step_snapshot() { # from the STILL-RUNNING original container; nothing is redeployed before this
  quiesce_once "$OUT/quiesce.txt"
  sed -n 's/^WP16_DBNOW //p' "$OUT/quiesce.txt" > "$OUT/snapshot-db-time.txt"
  [[ "$(cat "$OUT/snapshot-db-time.txt")" =~ $ISO_TS_RE ]] || die "DB timestamp missing or not ISO UTC"
  { shape_sh; db_sh; printf 'node /tmp/wp16-db.cjs runlogs %s/data/run-logs || die "runlog reconciliation failed"\n' "$I"
    inventory_sh; cat <<'EOF'
tar -C / -czf /tmp/wp16.tgz paperclip/instances/default/data/run-logs paperclip/instances/default/logs paperclip/instances/default/workspaces || die "tar failed"
(cd /paperclip/instances/default/workspaces && find . -mindepth 1 -type d > /tmp/wp16-wsd) || die "workspace scan failed"
LC_ALL=C sort /tmp/wp16-wsd > /tmp/wp16-wsds || die "workspace sort failed"
echo "WP16_WSDIRS $(tr '\n' ' ' < /tmp/wp16-wsds)"
h="$(sha256sum /tmp/wp16.tgz)" || die "archive hash failed"
echo "WP16_INFO archive_sha256 ${h%% *}"
echo "WP16_B64_BEGIN"; base64 /tmp/wp16.tgz || die "base64 failed"; echo "WP16_B64_END"
EOF
  } | remote snapshot "$OUT/snapshot.txt"
  local want got
  block INV "$OUT/snapshot.txt" > "$OUT/inventory-before.txt"
  grep -q '/data/run-logs/' "$OUT/inventory-before.txt" || die "inventory has no run-log files"
  block MISS "$OUT/snapshot.txt" > "$OUT/runlog-missing-before.txt"
  grep '^WP16_WSDIRS' "$OUT/snapshot.txt" > "$OUT/wsdirs-before.txt" || die "workspace dir list missing"
  grep '^WP16_INFO runlog_rows' "$OUT/snapshot.txt" > "$OUT/runlog-counts-before.txt"
  want="$(sed -n 's/^WP16_INFO archive_sha256 //p' "$OUT/snapshot.txt")"
  [ -n "$want" ] || die "remote archive sha256 missing"
  block B64 "$OUT/snapshot.txt" | base64 -d > "$OUT/paperclip-runlogs.tgz"
  rm -f "$OUT/snapshot.txt"
  got="$(sha256sum "$OUT/paperclip-runlogs.tgz" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || die "archive sha256 mismatch: remote $want local $got"
  printf '%s  paperclip-runlogs.tgz\n' "$got" > "$OUT/paperclip-runlogs.tgz.sha256"
  tar -tzf "$OUT/paperclip-runlogs.tgz" | LC_ALL=C sort > "$OUT/archive-list.txt"
  cut -c67- "$OUT/inventory-before.txt" | LC_ALL=C sort | comm -23 - "$OUT/archive-list.txt" > "$OUT/missing-from-archive.txt"
  [ ! -s "$OUT/missing-from-archive.txt" ] || die "archive lacks inventoried files"
  say "snapshot ok: $(wc -l < "$OUT/inventory-before.txt") files, sha256 $got; $(cat "$OUT/runlog-counts-before.txt")"
}

step_recheck() { # right before attach: nothing new in the original since the snapshot
  quiesce_once "$OUT/recheck-quiesce.txt" "$(cat "$OUT/snapshot-db-time.txt")"
  { shape_sh; inventory_sh; } | remote recheck "$OUT/recheck.txt"
  block INV "$OUT/recheck.txt" > "$OUT/inventory-recheck.txt"
  # run-logs must be byte-identical; server logs may have grown (health probes), same file set.
  diff <(grep '/data/run-logs/' "$OUT/inventory-before.txt") <(grep '/data/run-logs/' "$OUT/inventory-recheck.txt") > "$OUT/recheck.diff" \
    || die "run logs changed after the snapshot (see recheck.diff); re-run snapshot"
  diff <(grep '/logs/' "$OUT/inventory-before.txt" | cut -c67-) <(grep '/logs/' "$OUT/inventory-recheck.txt" | cut -c67-) >> "$OUT/recheck.diff" \
    || die "log file set changed after the snapshot; re-run snapshot"
  say "recheck ok: no new runs, run logs unchanged"
}

step_attach() { # new image + volume + backups off, heartbeats still paused (= restore-only mode)
  [ -s "$OUT/paperclip-runlogs.tgz.sha256" ] || die "no verified snapshot"
  railway variable set -s "$SVC" --skip-deploys PAPERCLIP_DB_BACKUP_ENABLED=false > /dev/null
  # Heartbeat runs come from Paperclip's own timer (every 2 h at even ET hours,
  # ~:35). The new container must run none until probe-check has passed;
  # `resume` re-enables it. The OLD container keeps its timer: run snapshot,
  # recheck and the image deploy inside one gap between batches.
  railway variable set -s "$SVC" --skip-deploys HEARTBEAT_SCHEDULER_ENABLED=false > /dev/null
  # New image FIRST: the old USER node image must never boot on a root-owned mount.
  confirm "Deploy the WP-16 image commit to $SVC (merge to its deploy branch), with NO volume yet. n8n heartbeats stay paused. Wait until the deployment is Active."
  railway volume -s "$SVC" add -m /paperclip --json > "$OUT/volume-add.json"
  confirm "Wait until the redeploy triggered by attaching the volume is Active (still the WP-16 image)."
  step_verify_runtime
}

step_verify_runtime() { # the image-level privilege-drop test; only possible on the live container
  step_transport
  cat <<'EOF' | remote verify-runtime "$OUT/verify-runtime.txt"
u="$(id -u node)"; g="$(id -g node)"; gs="$(id -G node)"
want_grps="$(printf '%s\n' $gs | sort -n | tr '\n' ' ')"
# The server process(es): match the image CMD exactly, not this script or grep.
pids=""
for d in /proc/[0-9]*; do
  c="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)" || continue
  case "$c" in "node --import ./server/node_modules/tsx/dist/loader.mjs server/src/index.ts"*) pids="$pids ${d#/proc/}" ;; esac
done
[ -n "$pids" ] || die "server process not found"
for p in $pids; do
  st="$(cat "/proc/$p/status")" || die "cannot read /proc/$p/status"
  uids="$(printf '%s\n' "$st" | awk '/^Uid:/ {print $2, $3, $4, $5}')"
  gids="$(printf '%s\n' "$st" | awk '/^Gid:/ {print $2, $3, $4, $5}')"
  grps="$(printf '%s\n' "$st" | awk '/^Groups:/ {$1=""; print}' | tr ' ' '\n' | grep . | sort -n | tr '\n' ' ')"
  [ "$uids" = "$u $u $u $u" ] || die "server pid $p uids [$uids] are not all node ($u)"
  [ "$gids" = "$g $g $g $g" ] || die "server pid $p gids [$gids] are not all node ($g)"
  [ "$grps" = "$want_grps" ] || die "server pid $p groups [$grps] differ from node's [$want_grps]"
  tr '\0' '\n' < "/proc/$p/environ" | grep -qx 'HOME=/paperclip' || die "server pid $p HOME is not /paperclip"
done
f=/paperclip/instances/default/data/run-logs/.wp16-write-test
setpriv --reuid=node --regid=node --init-groups -- sh -c "echo ok > $f && rm -f $f" || die "write test as node failed"
echo "WP16_INFO server pid(s)$pids run as node uid=$u gid=$g groups=[$want_grps]; HOME ok; run-logs writable as node"
EOF
}

step_restore() { # empty volume only; checked base64 transfer in chunks
  [ -s "$OUT/paperclip-runlogs.tgz.sha256" ] || die "no verified snapshot"
  ( cd "$OUT" && sha256sum -c paperclip-runlogs.tgz.sha256 > /dev/null ) || die "local archive changed since snapshot"
  quiesce_once "$OUT/restore-quiesce.txt"
  cat <<'EOF' | remote restore-precheck "$OUT/restore-precheck.txt"
I=/paperclip/instances/default
find /paperclip -type f ! -path "$I/logs/*" > /tmp/wp16-present || die "find failed"
[ ! -s /tmp/wp16-present ] || die "volume is not empty outside logs/; refusing to restore over it"
rm -f /tmp/wp16-up.b64
EOF
  local sha chunk; sha="$(cut -d' ' -f1 "$OUT/paperclip-runlogs.tgz.sha256")"
  { base64 -w0 "$OUT/paperclip-runlogs.tgz"; echo; } | fold -w 18000 > "$OUT/upload.b64"
  while IFS= read -r chunk; do
    printf "printf '%%s' '%s' >> /tmp/wp16-up.b64\n" "$chunk" | remote upload "$OUT/upload.txt"
  done < "$OUT/upload.b64"
  { printf 'want=%s\n' "$sha"; cat <<'EOF'
I=/paperclip/instances/default
base64 -d /tmp/wp16-up.b64 > /tmp/wp16.tgz || die "decode failed"
h="$(sha256sum /tmp/wp16.tgz)" || die "hash failed"
[ "${h%% *}" = "$want" ] || die "uploaded archive sha256 mismatch"
rm -rf /tmp/wp16-x && mkdir /tmp/wp16-x && tar -C /tmp/wp16-x -xzf /tmp/wp16.tgz || die "extract failed"
cp -a /tmp/wp16-x/paperclip/instances/default/data/run-logs/. "$I/data/run-logs/" || die "copy run-logs failed"
# Old server logs go beside the new server's live log, never over it.
mkdir -p "$I/workspaces" && cp -a /tmp/wp16-x/paperclip/instances/default/workspaces/. "$I/workspaces/" || die "copy workspaces failed"
(cd "$I/workspaces" && find . -mindepth 1 -type d > /tmp/wp16-wsd) || die "workspace scan failed"
LC_ALL=C sort /tmp/wp16-wsd > /tmp/wp16-wsds || die "workspace sort failed"
echo "WP16_WSDIRS $(tr '\n' ' ' < /tmp/wp16-wsds)"
mkdir -p "$I/logs/pre-wp16" && cp -a /tmp/wp16-x/paperclip/instances/default/logs/. "$I/logs/pre-wp16/" || die "copy logs failed"
chown -R -h node:node /paperclip || die "chown failed"
find "$I/data/storage" -type f > /tmp/wp16-st || die "find failed"
[ ! -s /tmp/wp16-st ] || die "data/storage has files; shape changed, re-plan"
cd /
: > /tmp/wp16-inv
find paperclip/instances/default/data/run-logs paperclip/instances/default/logs/pre-wp16 -type f > /tmp/wp16-files || die "find failed"
while IFS= read -r f; do sha256sum "$f" >> /tmp/wp16-inv || die "hash failed"; done < /tmp/wp16-files
echo "WP16_INV_BEGIN"; sed 's#paperclip/instances/default/logs/pre-wp16/#paperclip/instances/default/logs/#' /tmp/wp16-inv | LC_ALL=C sort -k2; echo "WP16_INV_END"
rm -rf /tmp/wp16-x /tmp/wp16.tgz /tmp/wp16-up.b64
EOF
    db_sh; printf 'node /tmp/wp16-db.cjs runlogs %s/data/run-logs || die "runlog reconciliation failed"\n' "$I"
    printf "node /tmp/wp16-db.cjs writes '%s' || die \"writes since snapshot\"\n" "$(snap_ts)"
  } | remote restore "$OUT/restore.txt"
  block INV "$OUT/restore.txt" > "$OUT/inventory-restored.txt"
  grep '^WP16_WSDIRS' "$OUT/restore.txt" | diff "$OUT/wsdirs-before.txt" - > /dev/null || die "workspace dirs differ after restore"
  diff "$OUT/inventory-before.txt" "$OUT/inventory-restored.txt" > "$OUT/restore.diff" \
    || die "restored files differ from the snapshot (see restore.diff)"
  block MISS "$OUT/restore.txt" > "$OUT/runlog-missing-after.txt"
  say "before: $(cat "$OUT/runlog-counts-before.txt")"
  say "after:  $(grep '^WP16_INFO runlog_rows' "$OUT/restore.txt")"
  LC_ALL=C sort "$OUT/runlog-missing-before.txt" > "$OUT/mb"; LC_ALL=C sort "$OUT/runlog-missing-after.txt" > "$OUT/ma"
  comm -13 "$OUT/mb" "$OUT/ma" > "$OUT/runlog-new-misses.txt"
  [ ! -s "$OUT/runlog-new-misses.txt" ] || die "$(wc -l < "$OUT/runlog-new-misses.txt") run logs referenced by the DB are newly missing"
  say "restore verified: every hash matches, no new run-log misses vs baseline"
}

step_probe_plant() {
  local nonce; nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s\n' "$nonce" > "$OUT/probe-nonce.txt"
  printf 'setpriv --reuid=node --regid=node --init-groups -- sh -c "echo %s > %s/data/storage/.persist-probe" || die "probe write failed"\n' "$nonce" "$I" \
    | remote probe-plant "$OUT/probe-plant.txt"
  confirm "Redeploy $SVC (railway redeploy -s $SVC -y). Heartbeats stay paused. Wait for Active."
}

step_probe_check() {
  [ -s "$OUT/probe-nonce.txt" ] || die "no probe nonce; run probe-plant first"
  local nonce; nonce="$(cat "$OUT/probe-nonce.txt")"
  { printf 'p="$(cat %s/data/storage/.persist-probe)" || die "probe missing"\necho "WP16_PROBE $p"\nrm -f %s/data/storage/.persist-probe\n' "$I" "$I"
    cat <<'EOF'
cd /
find paperclip/instances/default/data/run-logs paperclip/instances/default/logs/pre-wp16 -type f > /tmp/wp16-files || die "find failed"
: > /tmp/wp16-inv
while IFS= read -r f; do sha256sum "$f" >> /tmp/wp16-inv || die "hash failed"; done < /tmp/wp16-files
echo "WP16_INV_BEGIN"; sed 's#paperclip/instances/default/logs/pre-wp16/#paperclip/instances/default/logs/#' /tmp/wp16-inv | LC_ALL=C sort -k2; echo "WP16_INV_END"
EOF
    db_sh; printf "node /tmp/wp16-db.cjs writes '%s' || die \"writes since snapshot\"\n" "$(snap_ts)"
  } | remote probe-check "$OUT/probe-check.txt"
  grep -qx "WP16_PROBE $nonce" "$OUT/probe-check.txt" || die "probe content lost across redeploy"
  block INV "$OUT/probe-check.txt" > "$OUT/inventory-after.txt"
  diff "$OUT/inventory-before.txt" "$OUT/inventory-after.txt" > "$OUT/persist.diff" || die "files differ after redeploy (see persist.diff)"
  step_verify_runtime
  say "PAPERCLIP_STATE_PERSISTS"
  say "Next: resume (re-enables the heartbeat scheduler)."
}

step_resume() { # after PAPERCLIP_STATE_PERSISTS; HEARTBEAT_SCHEDULER_ENABLED was unset before attach
  # Re-runnable: if an earlier attempt deleted the variable but its deploy
  # failed, redeploy instead. Names only pass through cut.
  if railway variable list -s "$SVC" --kv | cut -d= -f1 | grep -qx HEARTBEAT_SCHEDULER_ENABLED; then
    railway variable delete -s "$SVC" HEARTBEAT_SCHEDULER_ENABLED > /dev/null
    confirm "Wait until the redeploy triggered by the variable delete is Active."
  else
    confirm "Variable already gone. Redeploy $SVC (railway redeploy -s $SVC -y) and wait for Active."
  fi
  step_verify_runtime
  # The running server's own environment must not carry the off switch.
  cat <<'EOF' | remote resume-check "$OUT/resume-check.txt"
n=0
for d in /proc/[0-9]*; do
  c="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)" || continue
  case "$c" in "node --import ./server/node_modules/tsx/dist/loader.mjs server/src/index.ts"*)
    n=$((n + 1))
    if tr '\0' '\n' < "$d/environ" | grep -q '^HEARTBEAT_SCHEDULER_ENABLED='; then die "server still has HEARTBEAT_SCHEDULER_ENABLED set"; fi ;;
  esac
done
[ "$n" -gt 0 ] || die "server process not found"
echo "WP16_INFO scheduler variable absent in $n server process(es)"
EOF
  say "Heartbeat scheduler re-enabled (overdue agents run at boot)."
}

step_rollback() {
  say "Triggers: any failure in attach, verify-runtime, restore, probe-plant or probe-check."
  say "Bounded loss: run-log history only. Postgres is untouched (external, daily backups + PITR); no secrets are stored yet."
  say "Previous deployment (rollback target):"
  sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$OUT/deployments-before.json" | head -n 1
  say "If the WP-16 image booted at least once, the volume is node-owned and the old USER node image can use it."
  say "If it never booted: railway volume -s $SVC detach -v <id in $OUT/volume-add.json> first."
  confirm "In the Railway dashboard, open that deployment and choose Redeploy (the CLI only redeploys the latest)."
  say "Archive kept at $OUT/paperclip-runlogs.tgz, sha256 $(cut -d' ' -f1 "$OUT/paperclip-runlogs.tgz.sha256")"
}

case "${1:-help}" in
  transport) step_transport ;;
  preflight) step_preflight ;;
  record) step_record ;;
  quiesce) step_quiesce ;;
  snapshot) step_snapshot ;;
  recheck) step_recheck ;;
  attach) step_attach ;;
  verify-runtime) step_verify_runtime ;;
  restore) step_restore ;;
  probe-plant) step_probe_plant ;;
  probe-check) step_probe_check ;;
  resume) step_resume ;;
  rollback) step_rollback ;;
  *) say "order: preflight record quiesce snapshot recheck attach restore probe-plant probe-check (rollback on any failure)" ;;
esac
