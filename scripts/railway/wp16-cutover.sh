#!/usr/bin/env bash
# WP-16 cutover: move Paperclip state from the image filesystem onto a Railway
# volume mounted at /paperclip. Run by the owner from Git Bash, one step at a
# time, in the order printed by `help`. Every step fails closed.
#
# Never prints environment values: remote scripts report variable NAMES and
# set/unset only, and archive/base64 data goes to files, never the terminal.
#
#   SVC=<service> OUT=<dir> scripts/railway/wp16-cutover.sh <step>
set -euo pipefail
export MSYS_NO_PATHCONV=1

SVC="${SVC:?set SVC to the Railway service name}"
OUT="${OUT:?set OUT to a local directory outside the repo for cutover state}"
STATE_DIR=/paperclip
mkdir -p "$OUT"

say() { printf '%s\n' "$*"; }
die() { printf 'WP16_FAIL: %s\n' "$*" >&2; exit 1; }
confirm() {
  printf '\nOWNER STEP: %s\nType yes when done: ' "$1"
  local a; read -r a < /dev/tty
  [ "$a" = yes ] || die "owner step not confirmed: $1"
}

# remote <step> <outfile>  (remote POSIX sh script on stdin)
# The script is shipped as one base64 argument, so no quoting survives the
# ssh hop and stdin forwarding is not needed. A remote step counts as done only
# if its last line is "WP16_REMOTE_OK <step>"; exit codes through the Railway
# CLI are not trusted alone. Output may carry CRs from a pty; they are stripped.
remote() {
  local step="$1" out="$2" b64
  b64="$( { printf 'set -eu\ndie() { echo "WP16_ERR $*"; exit 1; }\n'; cat; printf '\necho "WP16_REMOTE_OK %s"\n' "$step"; } | base64 -w0)"
  if ! railway ssh -s "$SVC" -- "echo $b64 | base64 -d > /tmp/wp16-step.sh && sh /tmp/wp16-step.sh" > "$out.raw" 2> "$out.err"; then
    grep -E '^WP16_(ERR|WARN)' "$out.raw" | tr -d '\r' >&2 || true
    die "railway ssh failed in step $step (stderr in $out.err)"
  fi
  tr -d '\r' < "$out.raw" > "$out"; rm -f "$out.raw"
  grep -E '^WP16_(ERR|WARN|INFO)' "$out" || true
  [ "$(tail -n 1 "$out")" = "WP16_REMOTE_OK $step" ] || die "remote step $step did not complete"
}

# Shared remote JS: DB access through the server's own postgres client, read-only.
db_js_prelude() {
  cat <<'JS'
const postgres = require(require.resolve("postgres", { paths: ["/app/packages/db"] }));
const fs = require("fs");
const cfgPath = process.env.PAPERCLIP_CONFIG || "/paperclip/instances/default/config.json";
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch { console.log("WP16_WARN config unreadable"); }
const url = process.env.DATABASE_URL || (cfg.database && cfg.database.mode === "postgres" ? cfg.database.connectionString : undefined);
if (!url) { console.log("WP16_ERR no external database (embedded Postgres is not supported by this cutover)"); process.exit(1); }
const sql = postgres(url, { max: 1, onnotice: () => {} });
const ro = (fn) => sql.begin("read only", fn);
JS
}

# ---------------------------------------------------------------- steps

step_transport() { # control: the ssh hop runs a script and returns its output
  local n; n="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  remote transport "$OUT/transport.txt" <<EOF
echo "WP16_INFO echo $n"
echo "WP16_INFO uid \$(id -u)"
EOF
  grep -qx "WP16_INFO echo $n" "$OUT/transport.txt" || die "ssh round trip lost the nonce"
  say "transport ok (remote uid $(sed -n 's/^WP16_INFO uid //p' "$OUT/transport.txt"))"
}

step_preflight() { # read-only: effective paths, overrides, symlinks, key, space
  step_transport
  { cat <<'EOF'
for n in HOME PAPERCLIP_HOME PAPERCLIP_INSTANCE_ID PAPERCLIP_CONFIG PAPERCLIP_STORAGE_PROVIDER \
  PAPERCLIP_STORAGE_LOCAL_DIR RUN_LOG_BASE_PATH PAPERCLIP_DB_BACKUP_DIR PAPERCLIP_DB_BACKUP_ENABLED \
  PAPERCLIP_LOG_DIR PAPERCLIP_SECRETS_MASTER_KEY_FILE PAPERCLIP_SECRETS_MASTER_KEY DATABASE_URL; do
  if eval "[ -n \"\${$n+x}\" ]"; then echo "WP16_INFO env $n set"; else echo "WP16_INFO env $n unset"; fi
done
cd /app
node - <<'JS'
EOF
    db_js_prelude
    cat <<'JS'
const path = require("path"), os = require("os"), crypto = require("crypto");
const home = path.resolve(process.env.PAPERCLIP_HOME || "/paperclip");
const root = path.resolve(home, "instances", process.env.PAPERCLIP_INSTANCE_ID || "default");
const exp = (v) => (v === "~" ? os.homedir() : v && v.startsWith("~/") ? path.join(os.homedir(), v.slice(2)) : v);
const pick = (env, file, def) => path.resolve(exp(process.env[env] ?? file ?? def));
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const inside = (p) => p === home || p.startsWith(home + "/");
let bad = 0;
const check = (label, p, durable) => {
  const r = real(p);
  const ok = inside(p) && (r === null || inside(r));
  console.log(`WP16_INFO path ${label} ${p} real=${r ?? "(missing)"} ${ok ? "inside" : "OUTSIDE"}`);
  if (!ok && durable) { bad++; console.log(`WP16_ERR durable path outside ${home}: ${label}`); }
};
check("config", cfgPath, true);
const storageProvider = process.env.PAPERCLIP_STORAGE_PROVIDER || cfg.storage?.provider || "local_disk";
console.log(`WP16_INFO storage provider ${storageProvider}`);
if (storageProvider === "local_disk")
  check("storage", pick("PAPERCLIP_STORAGE_LOCAL_DIR", cfg.storage?.localDisk?.baseDir, path.join(root, "data/storage")), true);
check("run-logs", path.resolve(process.env.RUN_LOG_BASE_PATH ?? path.join(root, "data/run-logs")), true);
check("backups", pick("PAPERCLIP_DB_BACKUP_DIR", cfg.database?.backup?.dir, path.join(root, "data/backups")), true);
check("logs", pick("PAPERCLIP_LOG_DIR", cfg.logging?.logDir, path.join(root, "logs")), false);
check("workspaces", path.join(root, "workspaces"), true);
const keyFile = pick("PAPERCLIP_SECRETS_MASTER_KEY_FILE", cfg.secrets?.localEncrypted?.keyFilePath, path.join(root, "secrets/master.key"));
console.log(`WP16_INFO master key from variable: ${process.env.PAPERCLIP_SECRETS_MASTER_KEY ? "yes" : "no"}`);
if (fs.existsSync(keyFile)) {
  const fp = crypto.createHash("sha256").update(fs.readFileSync(keyFile)).digest("hex").slice(0, 16);
  console.log(`WP16_INFO master key file fingerprint sha256:${fp}`);
  check("master-key-file", keyFile, true);
} else console.log("WP16_INFO master key file absent");
(async () => {
  const rows = await ro((s) => s`
    select 'project_workspace' as kind, cwd from project_workspaces where cwd is not null
    union select 'agent_cwd', adapter_config->>'cwd' from agents where adapter_config ? 'cwd'`);
  for (const { kind, cwd } of rows) {
    const p = path.resolve(exp(cwd));
    if (real(p) === null) { console.log(`WP16_WARN ${kind} ${p} does not exist in this container`); continue; }
    check(kind, p, true);
  }
  await sql.end();
  if (bad) process.exit(1);
})().catch((e) => { console.log("WP16_ERR db query failed: " + e.message); process.exit(1); });
JS
    cat <<'EOF'
JS
find /paperclip -type l > /tmp/wp16-links || die "find symlinks failed"
out=0
while IFS= read -r l; do
  t="$(readlink -f "$l")" || t="(dangling)"
  case "$t" in /paperclip|/paperclip/*) ;; *) echo "WP16_ERR symlink $l points outside /paperclip"; out=1 ;; esac
done < /tmp/wp16-links
[ "$out" = 0 ] || die "symlinks leave /paperclip"
du -sk /paperclip > /tmp/wp16-du || die "du failed"
df -Pk /tmp > /tmp/wp16-df || die "df failed"
used="$(cut -f1 /tmp/wp16-du)"
avail="$(awk 'NR==2 {print $4}' /tmp/wp16-df)"
echo "WP16_INFO size kib used=$used tmp_avail=$avail"
[ "$avail" -gt "$used" ] || die "not enough space in /tmp for the archive"
EOF
  } | remote preflight "$OUT/preflight.txt"
  say "preflight passed; report in $OUT/preflight.txt"
}

step_record() { # rollback facts: deployments and variable NAMES only
  railway deployment list -s "$SVC" --limit 5 --json > "$OUT/deployments-before.json"
  # --kv prints values; only the name column is kept and nothing is echoed.
  railway variable list -s "$SVC" --kv | cut -d= -f1 | LC_ALL=C sort > "$OUT/variable-names-before.txt"
  [ -s "$OUT/variable-names-before.txt" ] || die "no variable names recorded"
  railway volume list --json > "$OUT/volumes-before.json"
  say "recorded: $OUT/deployments-before.json (first entry = rollback target), variable-names-before.txt, volumes-before.json"
}

quiesce_js() {
  printf 'cd /app\nnode - <<'"'"'JS'"'"'\n'
  db_js_prelude
  cat <<'JS'
(async () => {
  const [r] = await ro((s) => s`select
    (select count(*)::int from heartbeat_runs where status in ('queued','running')) as live_runs,
    (select count(*)::int from agents where status not in ('paused','terminated','pending_approval')) as unpaused`);
  console.log(`WP16_INFO live_runs=${r.live_runs} unpaused_agents=${r.unpaused}`);
  await sql.end();
  if (r.live_runs !== 0 || r.unpaused !== 0) process.exit(3);
})().catch((e) => { console.log("WP16_ERR db query failed: " + e.message); process.exit(1); });
JS
  printf 'JS\n'
}

step_quiesce() { # owner pauses the schedulers, then wait for zero live runs
  confirm "In n8n, deactivate every Paperclip heartbeat workflow (do not delete them)."
  confirm "In Paperclip (Agents page), pause every agent. There is no maintenance flag in this build."
  local i
  for i in $(seq 1 60); do
    if quiesce_js | remote quiesce "$OUT/quiesce.txt" 2>/dev/null; then
      say "quiesced: no live runs, all agents paused"; return 0
    fi
    sleep 10
  done
  die "still live runs or unpaused agents after 10 minutes (see $OUT/quiesce.txt)"
}

# Inventory of every regular file under /paperclip: "sha256  relative/path".
inventory_sh() {
  cat <<'EOF'
cd /
find paperclip -type f ! -path 'paperclip/.wp16-*' > /tmp/wp16-files || die "find failed"
: > /tmp/wp16-inv
while IFS= read -r f; do sha256sum "$f" >> /tmp/wp16-inv || die "hash failed"; done < /tmp/wp16-files
LC_ALL=C sort -k2 /tmp/wp16-inv > /tmp/wp16-inv.sorted
[ -s /tmp/wp16-inv.sorted ] || die "empty inventory"
echo "WP16_INV_BEGIN"; cat /tmp/wp16-inv.sorted; echo "WP16_INV_END"
EOF
}
extract_inv() { # extract_inv <remote-output> <dest>; strips the probe file
  sed -n '/^WP16_INV_BEGIN$/,/^WP16_INV_END$/p' "$1" | sed '1d;$d' | { grep -v '/\.persist-probe$' || true; } > "$2"
  [ -s "$2" ] || die "empty inventory in $1"
}

step_snapshot() { # from the STILL-RUNNING original container; no redeploy before this
  quiesce_js | remote quiesce "$OUT/quiesce.txt"
  { inventory_sh; cat <<'EOF'
tar -C / -czf /tmp/wp16.tgz paperclip || die "tar failed"
h="$(sha256sum /tmp/wp16.tgz)" || die "archive hash failed"
echo "WP16_INFO archive_sha256 ${h%% *}"
echo "WP16_B64_BEGIN"; base64 /tmp/wp16.tgz || die "base64 failed"; echo "WP16_B64_END"
EOF
  } | remote snapshot "$OUT/snapshot.txt"
  local want got
  extract_inv "$OUT/snapshot.txt" "$OUT/inventory-before.txt"
  want="$(sed -n 's/^WP16_INFO archive_sha256 //p' "$OUT/snapshot.txt")"
  [ -n "$want" ] || die "remote archive sha256 missing"
  sed -n '/^WP16_B64_BEGIN$/,/^WP16_B64_END$/p' "$OUT/snapshot.txt" | sed '1d;$d' | base64 -d > "$OUT/paperclip.tgz"
  rm -f "$OUT/snapshot.txt"   # held the base64 archive (secrets); keep only the binary
  got="$(sha256sum "$OUT/paperclip.tgz" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || die "archive sha256 mismatch: remote $want local $got"
  printf '%s  paperclip.tgz\n' "$got" > "$OUT/paperclip.tgz.sha256"
  # Every inventoried file must be in the archive.
  tar -tzf "$OUT/paperclip.tgz" | LC_ALL=C sort > "$OUT/archive-list.txt"
  cut -c67- "$OUT/inventory-before.txt" | LC_ALL=C sort | comm -23 - "$OUT/archive-list.txt" > "$OUT/missing-from-archive.txt"
  [ ! -s "$OUT/missing-from-archive.txt" ] || die "archive lacks inventoried files (see missing-from-archive.txt)"
  say "snapshot ok: $(wc -l < "$OUT/inventory-before.txt") files, sha256 $got"
  say "keep $OUT/paperclip.tgz and its .sha256 off the service until WP-16 is closed"
}

step_attach() { # variable, volume, new image; agents stay paused throughout
  [ -s "$OUT/paperclip.tgz.sha256" ] || die "no verified snapshot; run snapshot first"
  railway variable set -s "$SVC" --skip-deploys PAPERCLIP_DB_BACKUP_ENABLED=false > /dev/null
  # New image first (snapshot is safe locally), so the old USER-node image never
  # boots on a root-owned volume.
  confirm "Deploy the WP-16 image commit to $SVC (merge to its deploy branch). Leave n8n heartbeats and agents PAUSED. Wait until the deployment is Active."
  railway volume -s "$SVC" add -m "$STATE_DIR" --json > "$OUT/volume-add.json"
  say "volume created; ids in $OUT/volume-add.json"
  confirm "Wait until the redeploy that attaching the volume triggers is Active (agents still paused)."
  step_transport
  grep -qx 'WP16_INFO uid 0' "$OUT/transport.txt" || die "new container shell is not root; is the WP-16 image live?"
}

step_restore() { # upload, verify hash, replace volume contents, verify inventory, write test
  [ -s "$OUT/volume-add.json" ] || die "no volume-add.json; run attach first"
  [ -s "$OUT/paperclip.tgz.sha256" ] || die "no verified snapshot; run snapshot first"
  quiesce_js | remote quiesce "$OUT/quiesce.txt"
  local vol sha
  vol="$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$OUT/volume-add.json" | head -n 1)"
  [ -n "$vol" ] || die "volume id not found in volume-add.json"
  sha="$(cut -d' ' -f1 "$OUT/paperclip.tgz.sha256")"
  ( cd "$OUT" && sha256sum -c paperclip.tgz.sha256 > /dev/null ) || die "local archive changed since snapshot"
  railway volume files upload -v "$vol" --overwrite "$OUT/paperclip.tgz" /.wp16-restore.tgz > /dev/null
  { cat <<EOF
want=$sha
EOF
    cat <<'EOF'
a=/paperclip/.wp16-restore.tgz
h="$(sha256sum "$a")" || die "hash of upload failed"
[ "${h%% *}" = "$want" ] || die "uploaded archive sha256 mismatch"
find /paperclip -mindepth 1 -maxdepth 1 ! -name .wp16-restore.tgz -exec rm -rf {} + || die "clearing volume failed"
tar -C / -xzf "$a" || die "extract failed"
rm -f "$a"
chown -R -h node:node /paperclip || die "chown failed"
setpriv --reuid=node --regid=node --init-groups -- sh -c 't=/paperclip/instances/default/data/storage/.wp16-write-test; echo ok > "$t" && rm -f "$t"' \
  || die "write test as node failed"
echo "WP16_INFO write test as node ok"
EOF
    inventory_sh
  } | remote restore "$OUT/restore.txt"
  extract_inv "$OUT/restore.txt" "$OUT/inventory-restored.txt"
  diff "$OUT/inventory-before.txt" "$OUT/inventory-restored.txt" > "$OUT/restore.diff" \
    || die "restored inventory differs from snapshot (see restore.diff)"
  say "restore verified: every file matches the pre-cutover inventory"
  confirm "Redeploy $SVC once (railway redeploy -s $SVC -y) so the server boots on the restored state. Keep agents paused. Wait for Active."
}

durable() { grep -v -E '  paperclip/instances/[^/]+/logs/' "$1"; } # server logs are appended on boot

step_probe_plant() {
  step_transport
  local nonce; nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s\n' "$nonce" > "$OUT/probe-nonce.txt"
  { cat <<EOF
setpriv --reuid=node --regid=node --init-groups -- sh -c 'echo $nonce > /paperclip/instances/default/data/storage/.persist-probe' || die "probe write as node failed"
EOF
    inventory_sh
  } | remote probe-plant "$OUT/probe-plant.txt"
  extract_inv "$OUT/probe-plant.txt" "$OUT/inventory-before-redeploy.txt"
  diff <(durable "$OUT/inventory-before.txt") <(durable "$OUT/inventory-before-redeploy.txt") > "$OUT/boot.diff" \
    || die "durable files changed across the restore boot (see boot.diff)"
  confirm "Redeploy $SVC again (railway redeploy -s $SVC -y). Wait for Active."
}

step_probe_check() {
  [ -s "$OUT/probe-nonce.txt" ] || die "no probe nonce; run probe-plant first"
  local nonce; nonce="$(cat "$OUT/probe-nonce.txt")"
  { printf 'echo "WP16_INFO probe $(cat /paperclip/instances/default/data/storage/.persist-probe)"\n'; inventory_sh; } \
    | remote probe-check "$OUT/probe-check.txt"
  grep -qx "WP16_INFO probe $nonce" "$OUT/probe-check.txt" || die "probe content lost across redeploy"
  extract_inv "$OUT/probe-check.txt" "$OUT/inventory-after.txt"
  diff <(durable "$OUT/inventory-before.txt") <(durable "$OUT/inventory-after.txt") > "$OUT/persist.diff" \
    || die "durable files differ after redeploy (see persist.diff)"
  grep -qE '  paperclip/instances/[^/]+/data/storage/' "$OUT/inventory-after.txt" || say "WARN: no attachment files in inventory"
  grep -qE '  paperclip/instances/[^/]+/data/run-logs/' "$OUT/inventory-after.txt" || say "WARN: no run-log files in inventory"
  say "PAPERCLIP_STATE_PERSISTS"
  say "Owner: resume agents in Paperclip, then re-activate the n8n heartbeat workflows."
}

step_rollback() {
  local prev; prev="$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$OUT/deployments-before.json" | head -n 1)"
  [ -n "$prev" ] || die "no recorded previous deployment"
  say "Rollback triggers: any verification, health or write-test failure in steps restore/probe-plant/probe-check."
  say "Volume ownership is already node:node (restore ran chown -R -h), so the old USER node image can use it."
  confirm "In Railway, open deployment $prev of $SVC and choose Redeploy (the CLI only redeploys the latest). Leave the volume attached. Agents stay paused."
  say "Snapshot kept at $OUT/paperclip.tgz ($(cut -d' ' -f1 "$OUT/paperclip.tgz.sha256"))."
  say "To drop the volume afterwards: railway volume -s $SVC detach -v <id from $OUT/volume-add.json> (the old image then runs on its ephemeral /paperclip; restore from the archive if needed)."
}

case "${1:-help}" in
  transport) step_transport ;;
  preflight) step_preflight ;;
  record) step_record ;;
  quiesce) step_quiesce ;;
  snapshot) step_snapshot ;;
  attach) step_attach ;;
  restore) step_restore ;;
  probe-plant) step_probe_plant ;;
  probe-check) step_probe_check ;;
  rollback) step_rollback ;;
  *) say "order: preflight record quiesce snapshot attach restore probe-plant probe-check (rollback on any failure)" ;;
esac
