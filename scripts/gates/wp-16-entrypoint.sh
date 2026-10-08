#!/bin/sh
# WP-16 gate: the Railway image must repair /paperclip ownership and drop to
# node before the server CMD runs, failing closed on every error.
#
# Static checks on Dockerfile.railway, then a behavioral harness: it "starts the
# container" the way Docker would (ENTRYPOINT + CMD, or CMD alone when there is
# no ENTRYPOINT) with stubbed id/stat/chown/setpriv/test on PATH. Each stub
# records its argv one argument per line, so argument boundaries are checked.
#
# Usage: sh scripts/gates/wp-16-entrypoint.sh [repo-root]
set -u

root="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
df="$root/Dockerfile.railway"
fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
work="$(mktemp -d)" || exit 2
trap 'rm -rf "$work"' EXIT

# ---- static ----
if [ -f "$df" ]; then
  tr -d '\r' < "$df" > "$work/Dockerfile"
else
  fail "missing $df"; : > "$work/Dockerfile"
fi
dfx="$work/Dockerfile"
grep -Eq '^USER[[:space:]]' "$dfx" && fail "Dockerfile.railway still has a USER line"
grep -Eq '^CMD \["node", "--import", "\./server/node_modules/tsx/dist/loader\.mjs", "server/src/index\.ts"\]$' "$dfx" \
  || fail "CMD changed or missing"
grep -Eq '^  CMD curl -q -sf http://localhost:3100/api/health \|\| exit 1$' "$dfx" \
  || fail "HEALTHCHECK curl must start with -q (ignore \$HOME/.curlrc while running as root)"
grep -Eq '^ENV .*HOME=/paperclip|^  HOME=/paperclip' "$dfx" || fail "HOME not /paperclip"
grep -Eq 'PAPERCLIP_HOME=/paperclip' "$dfx" || fail "PAPERCLIP_HOME not /paperclip"

# ENTRYPOINT ["/app/x"] -> $root/x ; empty when absent (Docker then runs CMD directly).
ep_in_image="$(sed -n 's/^ENTRYPOINT \["\([^"]*\)"\]$/\1/p' "$dfx")"
ep=""
[ -n "$ep_in_image" ] && ep="$root/${ep_in_image#/app/}"
if [ -n "$ep" ]; then
  [ -f "$ep" ] || fail "ENTRYPOINT $ep_in_image not found in repo"
  grep -Eq '^set -eu$' "$ep" || fail "entrypoint lacks set -eu"
fi

# ---- behavioral ----
# start_container <case-name>; env knobs: CHOWN_RC TEST_RC SETPRIV_EXEC_RC ID_RC
# Sets: rc (exit status), log (recorded calls), state (fake volume path).
start_container() {
  t="$work/$1"; mkdir -p "$t/bin" "$t/state"
  log="$t/calls.log"; : > "$log"; state="$t/state"
  for name in id stat chown setpriv test fake-cmd; do
    cat > "$t/bin/$name" <<EOF
#!/bin/sh
{ echo "== $name"; for a in "\$@"; do printf 'arg:%s\n' "\$a"; done; } >> "$log"
EOF
  done
  cat >> "$t/bin/id" <<'EOF'
[ "${ID_RC:-0}" = 0 ] || exit "$ID_RC"
[ "$1 $2" = "-u node" ] && echo 1000
EOF
  echo 'exit 0' >> "$t/bin/stat"
  echo 'exit "${CHOWN_RC:-0}"' >> "$t/bin/chown"
  echo '[ -z "${TEST_FAIL_DIR:-}" ] || [ "$2" != "$TEST_FAIL_DIR" ] || exit 1' >> "$t/bin/test"
  echo 'exit "${TEST_RC:-0}"' >> "$t/bin/test"
  cat >> "$t/bin/setpriv" <<'EOF'
while [ "$1" != "--" ]; do shift; done; shift
[ "$1" = test ] || [ "${SETPRIV_EXEC_RC:-0}" = 0 ] || exit "$SETPRIV_EXEC_RC"
exec "$@"
EOF
  chmod +x "$t/bin/"*
  # CMD stand-in: same shape as the real CMD, one argument contains spaces.
  set -- fake-cmd --import "./loader dir/loader.mjs" "server/src/index.ts"
  if [ -n "$ep" ] && [ -f "$ep" ]; then
    PATH="$t/bin:$PATH" PAPERCLIP_HOME="$state" PAPERCLIP_INSTANCE_ID=default sh "$ep" "$@" > "$t/out" 2>&1
  else
    # No ENTRYPOINT: Docker execs the CMD directly as the image USER.
    PATH="$t/bin:$PATH" PAPERCLIP_HOME="$state" "$@" > "$t/out" 2>&1
  fi
  rc=$?
}

# Line number of the first line equal to $1 in $log, or 0.
first() { grep -nxF -- "$1" "$log" | head -n 1 | cut -d: -f1 | grep . || echo 0; }

cmd_args="$(printf 'arg:%s\n' --import "./loader dir/loader.mjs" "server/src/index.ts")"

# Case 1: normal boot.
start_container ok
chown_at="$(first '== chown')"
cmd_at="$(first '== fake-cmd')"
if [ "$chown_at" = 0 ]; then
  fail "no ownership repair before CMD"
elif [ "$cmd_at" != 0 ] && [ "$chown_at" -gt "$cmd_at" ]; then
  fail "ownership repair ran after CMD"
fi
[ "$rc" = 0 ] || fail "normal boot exited $rc"
inst="$state/instances/default"
expected="$(
  printf '== id
arg:-u
arg:node
'
  printf '== chown
arg:-R
arg:-h
arg:node:node
arg:%s
' "$state"
  for d in "$state" "$inst" "$inst/data/run-logs" "$inst/data/storage"; do
    printf '== setpriv
arg:--reuid=node
arg:--regid=node
arg:--init-groups
arg:--
arg:test
arg:-w
arg:%s
' "$d"
    printf '== test
arg:-w
arg:%s
' "$d"
  done
  printf '== setpriv
arg:--reuid=node
arg:--regid=node
arg:--init-groups
arg:--
arg:fake-cmd
%s
' "$cmd_args"
  printf '== fake-cmd
%s
' "$cmd_args"
)"
if [ "$(cat "$log")" != "$expected" ]; then
  fail "normal boot call sequence differs (want: id, chown -R -h, setpriv-as-node writability checks of state, instance, run-logs, storage, setpriv-as-node exec of the CMD with argv intact)"
  printf '%s\n' "$expected" > "$work/expected"
  diff "$work/expected" "$log" | sed 's/^/    /' | head -n 40
fi
for d in "$inst/data/run-logs" "$inst/data/storage"; do
  [ -d "$d" ] || fail "$d not created by the entrypoint"
done

# Case 2: chown fails -> non-zero, no setpriv, no CMD.
CHOWN_RC=1 start_container chown-fails
[ "$rc" != 0 ] || fail "failing chown still exited 0"
grep -qxF '== setpriv' "$log" && fail "setpriv called after chown failed"
grep -qxF '== fake-cmd' "$log" && fail "CMD ran after chown failed"

# Case 3: writability check as node fails -> non-zero, no CMD.
TEST_RC=1 start_container not-writable
[ "$rc" != 0 ] || fail "failing writability check still exited 0"
grep -qxF '== fake-cmd' "$log" && fail "CMD ran although state dir is not writable as node"

# Case 3b: only a descendant (storage) is not writable as node -> non-zero, no CMD.
TEST_FAIL_DIR="$work/storage-not-writable/state/instances/default/data/storage" start_container storage-not-writable
[ "$rc" != 0 ] || fail "unwritable storage dir still exited 0"
grep -qxF '== fake-cmd' "$log" && fail "CMD ran although storage dir is not writable as node"

# Case 4: final privilege drop fails -> non-zero, CMD never runs.
SETPRIV_EXEC_RC=1 start_container drop-fails
[ "$rc" != 0 ] || fail "failing setpriv exec still exited 0"
grep -qxF '== fake-cmd' "$log" && fail "CMD ran after setpriv failed"

# Case 5: id fails -> non-zero before any chown (no masked substitution).
ID_RC=1 start_container id-fails
[ "$rc" != 0 ] || fail "failing id still exited 0"
grep -Eqx '== (chown|fake-cmd)' "$log" && fail "continued after id failed"

echo "NOTE: stub harness only. Real UID/GID switch, supplementary groups and Railway volume ownership are deploy-time checks (no Docker on this machine)."
if [ "$fails" = 0 ]; then
  echo "WP16_ENTRYPOINT_OK"
else
  echo "WP16_ENTRYPOINT_FAIL ($fails)"
  exit 1
fi
