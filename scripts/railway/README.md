# Railway scripts

## wp16-cutover.sh: move /paperclip onto a Railway volume

`Dockerfile.railway` runs `docker/railway-entrypoint.sh`. It re-owns `/paperclip`
to `node` on every boot, checks as node that the directory is writable, then
drops to node. That is what lets a root-owned Railway volume be mounted at
`/paperclip`. `wp16-cutover.sh` moves the existing state onto that volume.

Run it from Git Bash, one step at a time, with
`SVC=<service> OUT=<local dir outside the repo>`. `OUT` will hold a full copy
of the state, including secrets, so keep it private.

1. `preflight` (read-only). Checks that the ssh round trip works. Prints the
   effective config, storage, run-log, backup, workspace and key-file paths,
   which path variables are set (names only), and any symlinks that point
   outside `/paperclip`. Also prints whether the master key comes from its
   variable, and the sha256 fingerprint of the key file if one exists. Fails
   if any durable path is outside `/paperclip` or Postgres is embedded.
2. `record`. Saves recent deployments, variable names and volumes, for rollback.
3. `quiesce`. Owner steps: deactivate the n8n heartbeat workflows, then pause
   every agent. The step then polls until there are zero queued or running
   runs and zero unpaused agents. This build has no maintenance flag, so the
   paused agents and n8n workflows are what keep the new deployment from
   doing work until `probe-check` passes.
4. `snapshot`. Runs against the still-running original container. Builds a
   sha256 inventory and a tar archive, transfers it as base64, and compares
   the sha256 of the archive on both ends. Checks that every inventoried file
   is in the archive.
5. `attach`. Sets `PAPERCLIP_DB_BACKUP_ENABLED=false` (with `--skip-deploys`).
   The owner deploys the WP-16 image, then the step adds the volume at
   `/paperclip` and checks that the new container's shell is root.
6. `restore`. Uploads the archive with `railway volume files upload`, checks
   its sha256 on the remote side, and replaces the volume contents. Runs
   `chown -R -h node:node` and a write test as node. Fails unless the
   restored inventory equals the snapshot exactly. The owner then redeploys
   once.
7. `probe-plant`, then redeploy, then `probe-check`. Plants a random nonce at
   `data/storage/.persist-probe`. After the redeploy, checks that its content
   survived and that every durable inventory entry still matches (server logs
   are excluded because the server appends to them). Prints
   `PAPERCLIP_STATE_PERSISTS`. After that, resume the agents and n8n.

`rollback`: use it on any verification, health or write-test failure. It
prints the deployment to redeploy from the Railway dashboard. The volume is
already `node:node`, so the old `USER node` image can use it. The verified
archive stays in `OUT`, and the step prints how to detach the volume.

Not yet proven, only checkable at deploy time: real UID and group switching,
how Railway mounts the volume, the path root used by `volume files upload`,
and the JSON shapes that `record` and `attach` parse ids from.
