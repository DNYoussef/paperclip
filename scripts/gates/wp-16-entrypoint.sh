#!/bin/sh
# WP-16 gate: Dockerfile.railway drops root through docker/railway-entrypoint.sh.
# Static checks on the Dockerfile and script, then runs the script under sh with
# stubbed id/stat/chown/setpriv to assert call order and fail-closed behavior.
# Usage: sh scripts/gates/wp-16-entrypoint.sh [repo-root]
set -u

root="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
df="$root/Dockerfile.railway"
ep="$root/docker/railway-entrypoint.sh"
fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }

# ---- static ----
[ -f "$df" ] || fail "missing $df"
[ -f "$ep" ] || fail "missing $ep"
if [ -f "$df" ]; then
  tr -d '\r' < "$df" > "${TMPDIR:-/tmp}/wp16-df.$$"
  grep -Eq '^USER[[:space:]]' "${TMPDIR:-/tmp}/wp16-df.$$" && fail "Dockerfile.railway still has a USER line"
  grep -Eq '^ENTRYPOINT \["/app/docker/railway-entrypoint\.sh"\]' "${TMPDIR:-/tmp}/wp16-df.$$" || fail "ENTRYPOINT does not point at the script"
  grep -Eq '^CMD \["node", "--import", "\./server/node_modules/tsx/dist/loader\.mjs", "server/src/index\.ts"\]' "${TMPDIR:-/tmp}/wp16-df.$$" || fail "CMD changed or missing"
  grep -Eq '^HEALTHCHECK ' "${TMPDIR:-/tmp}/wp16-df.$$" || fail "HEALTHCHECK missing"
  grep -Eq 'HOME=/paperclip' "${TMPDIR:-/tmp}/wp16-df.$$" || fail "HOME not /paperclip"
  grep -Eq 'PAPERCLIP_HOME=/paperclip' "${TMPDIR:-/tmp}/wp16-df.$$" || fail "PAPERCLIP_HOME not /paperclip"
  rm -f "${TMPDIR:-/tmp}/wp16-df.$$"
fi
if [ -f "$ep" ]; then
  grep -Eq '^set -eu?$' "$ep" || fail "entrypoint lacks set -e"
  grep -Eq 'chown -R node:node "\$state_dir"' "$ep" || fail "entrypoint does not chown the state dir"
  grep -Eq '/paperclip' "$ep" || fail "entrypoint does not default to /paperclip"
  grep -Eq '^exec setpriv --reuid=node --regid=node --init-groups -- "\$@"$' "$ep" || fail "entrypoint does not exec setpriv to node"
fi

# ---- behavioral ----
run_case() { # name stat_uid setpriv_rc chown_rc -> sets rc, log
  t="$(mktemp -d)"
  mkdir -p "$t/bin" "$t/state"
  log="$t/calls.log"; : > "$log"
  printf '#!/bin/sh\n[ "$1 $2" = "-u node" ] && echo 1000 || exit 1\n' > "$t/bin/id"
  printf '#!/bin/sh\necho %s\n' "$2" > "$t/bin/stat"
  printf '#!/bin/sh\necho "chown $*" >> "%s"\nexit %s\n' "$log" "$4" > "$t/bin/chown"
  printf '#!/bin/sh\necho "setpriv $*" >> "%s"\n[ %s = 0 ] || exit %s\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n' "$log" "$3" "$3" > "$t/bin/setpriv"
  printf '#!/bin/sh\necho "cmd $*" >> "%s"\n' "$log" > "$t/bin/fake-cmd"
  chmod +x "$t/bin/"*
  PATH="$t/bin:$PATH" PAPERCLIP_HOME="$t/state" sh "$ep" fake-cmd --flag "a b" > /dev/null 2>&1
  rc=$?
  calls="$(cat "$log")"
  rm -rf "$t"
}

if [ -f "$ep" ]; then
  # 1. root-owned volume: chown first, then setpriv with the CMD args, then CMD.
  run_case root-owned 0 0 0
  [ "$rc" = 0 ] || fail "root-owned case exit $rc"
  case "$calls" in
    "chown -R node:node "*"/state
setpriv --reuid=node --regid=node --init-groups -- fake-cmd --flag a b
cmd --flag a b") ;;
    *) fail "root-owned call order wrong: $(echo "$calls" | tr '\n' '|')" ;;
  esac

  # 2. already node-owned: no recursive chown walk.
  run_case node-owned 1000 0 0
  [ "$rc" = 0 ] || fail "node-owned case exit $rc"
  echo "$calls" | grep -q '^chown' && fail "node-owned volume was re-chowned"
  echo "$calls" | grep -q '^cmd --flag a b$' || fail "node-owned case did not run CMD"

  # 3. setpriv fails: non-zero exit, CMD never runs.
  run_case setpriv-fails 0 1 0
  [ "$rc" != 0 ] || fail "failing setpriv still exited 0"
  echo "$calls" | grep -q '^cmd' && fail "CMD ran after setpriv failed"

  # 4. chown fails: non-zero exit, no setpriv, no CMD.
  run_case chown-fails 0 0 1
  [ "$rc" != 0 ] || fail "failing chown still exited 0"
  echo "$calls" | grep -Eq '^(setpriv|cmd)' && fail "continued after chown failed"
else
  fail "behavioral checks skipped: no entrypoint"
fi

if [ "$fails" = 0 ]; then
  echo "WP16_ENTRYPOINT_OK"
else
  echo "WP16_ENTRYPOINT_FAIL ($fails)"
  exit 1
fi
