#!/bin/sh
# Railway entrypoint: runs as root only long enough to make the state volume
# writable by node, then drops to node for good. Any failure exits non-zero;
# the CMD is never run as root.
set -eu

state_dir="${PAPERCLIP_HOME:-/paperclip}"
node_uid="$(id -u node)"
[ "$node_uid" != "0" ] || { echo "railway-entrypoint: node uid is 0, refusing" >&2; exit 1; }

mkdir -p "$state_dir"
# A fresh Railway volume mounts root-owned. Re-own the whole tree only when the
# top level is wrong, so a large volume is not walked on every boot.
# ponytail: files added as root under an already node-owned dir (railway ssh
# copy-ins) are not caught here; chown -R by hand after any root copy-in.
if [ "$(stat -c %u "$state_dir")" != "$node_uid" ]; then
  chown -R node:node "$state_dir"
fi

exec setpriv --reuid=node --regid=node --init-groups -- "$@"
