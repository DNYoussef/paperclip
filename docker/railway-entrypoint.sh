#!/bin/sh
# Railway entrypoint: runs as root only long enough to make the state volume
# owned and writable by node, then drops to node for good. Any failure exits
# non-zero; the CMD is never run as root.
set -eu

die() { echo "railway-entrypoint: $*" >&2; exit 1; }

state_dir="${PAPERCLIP_HOME:-/paperclip}"
instance_dir="$state_dir/instances/${PAPERCLIP_INSTANCE_ID:-default}"

# Plain assignment: set -e exits if id fails (no `|| ...`, no `local`).
node_uid="$(id -u node)"
[ -n "$node_uid" ] || die "could not resolve uid of node"
[ "$node_uid" != "0" ] || die "node uid is 0, refusing"

# The run-log and storage dirs are made here, so the as-node checks below
# cover the dirs the server actually writes.
mkdir -p "$instance_dir/data/run-logs" "$instance_dir/data/storage"
# -R with GNU's default -P: never follow symlinks while walking; -h: re-own the
# link itself, not its target. Exits non-zero if any entry fails.
# ponytail: walks the whole volume on every boot. Fine at current size; if boot
# time matters, switch to a marker file plus `find -not -user node`.
chown -R -h node:node "$state_dir" || die "chown of $state_dir failed"

for dir in "$state_dir" "$instance_dir" "$instance_dir/data/run-logs" "$instance_dir/data/storage"; do
  setpriv --reuid=node --regid=node --init-groups -- test -w "$dir" \
    || die "$dir is not writable as node"
done

exec setpriv --reuid=node --regid=node --init-groups -- "$@"
