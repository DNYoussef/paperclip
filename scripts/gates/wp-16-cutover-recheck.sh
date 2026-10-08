#!/usr/bin/env bash
# WP-16 gate: the cutover recheck must compare against the FULL snapshot
# timestamp. Earlier same-day runs must pass it, and a run created after the
# snapshot must fail it.
#
# Drives the real quiesce_once() from wp16-cutover.sh through a stubbed
# `railway` (it runs the shipped remote script under sh) and a stubbed `node`
# that parses argv exactly like the shipped DB helper: it reads ONE argument,
# casts it the way Postgres casts text to timestamptz, and compares it with
# the run creation times in RUNS.
#
# Usage: bash scripts/gates/wp-16-cutover-recheck.sh [path/to/wp16-cutover.sh]
set -u
script="${1:-$(cd "$(dirname "$0")/../.." && pwd)/scripts/railway/wp16-cutover.sh}"
work="$(mktemp -d)" || exit 2
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/sbin" "$work/app" "$work/out"

# Models the measured transport: a command line over 8192 chars is silently
# dropped (nothing runs, nothing returned). Otherwise the command runs under
# sh with /tmp/wp16-step* mapped into $WORK and the step script run there.
cat > "$work/bin/railway" <<'EOF'
#!/bin/bash
c="${@: -1}"
[ "${#c}" -le 8192 ] || exit 0
c="${c//\/tmp\/wp16-step/$WORK/wp16-step}"
c="${c//sh $WORK\/wp16-step.sh/sh $WORK/run-step}"
sh -c "$c"
EOF
cat > "$work/run-step" <<'EOF'
sed "s#^cd /app\$#cd $WORK/app#" "$WORK/wp16-step.sh" > "$WORK/step.sh"
PATH="$WORK/sbin:$PATH" sh "$WORK/step.sh"
EOF

# Postgres text->timestamptz for the inputs that matter here: a full ISO UTC
# value, a "YYYY-MM-DD HH:MM:SS.ffffff+00" value, or a bare date (= midnight).
cat > "$work/sbin/node" <<'EOF'
#!/bin/sh
[ "$2" = quiesce ] || exit 9
norm() {
  case "$1" in
    ????-??-??) echo "$1T00:00:00.000000Z" ;;
    ????-??-??T*Z) echo "$1" ;;
    "????-??-?? "*) echo "$1" | sed 's/ /T/; s/+00$/Z/' ;;
    *) echo "$1" | sed 's/ /T/; s/+00$/Z/' ;;
  esac
}
if grep -q 'to_char(now()' /tmp/wp16-db.cjs; then now="$SNAP_ISO"; else now="$SNAP_TEXT"; fi
if grep -q 'ISO_TS.test(arg)' /tmp/wp16-db.cjs && [ -n "${3+x}" ]; then
  echo "$3" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' \
    || { echo "WP16_ERR db query failed: since-ts is not an ISO UTC timestamp"; exit 1; }
fi
since=0
if [ -n "${3:-}" ]; then
  s="$(norm "$3")"
  for r in $RUNS; do [ "$r" \> "$s" ] && since=$((since + 1)); done
fi
echo "WP16_INFO live_runs=0 runs_created_since=${3:+$since}"
echo "WP16_DBNOW $now"
[ -z "${3:-}" ] || [ "$since" = 0 ]
EOF
chmod +x "$work/bin/railway" "$work/sbin/node"

export WORK="$work" PATH="$work/bin:$PATH" SVC=stub OUT="$work/out"
export SNAP_ISO="2026-10-07T12:34:56.123456Z" SNAP_TEXT="2026-10-07 12:34:56.123456+00"

# snapshot-then-recheck exactly as step_snapshot/step_recheck do it; prints PASS or FAIL
recheck() {
  ( source "$script" help > /dev/null
    quiesce_once "$OUT/q.txt" > /dev/null 2>&1 || exit 3
    sed -n 's/^WP16_DBNOW //p' "$OUT/q.txt" > "$OUT/snapshot-db-time.txt"
    quiesce_once "$OUT/r.txt" "$(cat "$OUT/snapshot-db-time.txt")" > /dev/null 2>&1 ) && echo PASS || echo FAIL
}

fails=0
got="$(RUNS="2026-10-07T08:00:00.000000Z 2026-10-06T23:00:00.000000Z" recheck)"
echo "same-day earlier run: recheck $got (want PASS)"
[ "$got" = PASS ] || fails=$((fails + 1))
got="$(RUNS="2026-10-07T08:00:00.000000Z 2026-10-07T12:40:00.000000Z" recheck)"
echo "run created after snapshot: recheck $got (want FAIL)"
[ "$got" = FAIL ] || fails=$((fails + 1))

# A step script whose base64 exceeds one command line must still run intact.
got="$( ( source "$script" help > /dev/null
  { printf '# %s\n' "$(head -c 9000 /dev/zero | tr '\0' p)"; echo 'echo "WP16_INFO long_ok"'; } \
    | remote long "$OUT/long.txt" > /dev/null 2>&1 && grep -qx 'WP16_INFO long_ok' "$OUT/long.txt" ) && echo PASS || echo FAIL)"
echo "step script over 8 KiB: $got (want PASS)"
[ "$got" = PASS ] || fails=$((fails + 1))

if [ "$fails" = 0 ]; then echo "WP16_RECHECK_OK"; else echo "WP16_RECHECK_FAIL ($fails)"; exit 1; fi
