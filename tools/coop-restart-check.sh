#!/bin/sh
# Builds the production image, drives real co-op scenarios with real
# WebSocket clients, then checks they recover correctly across (1) a real
# `docker restart` and (2) a rebuilt image on the same named volume — what
# a Fly redeploy actually does. Mirrors tools/persistence-check.sh's own
# pattern exactly, extended with real WebSocket clients (via the companion
# tools/coop-restart-check.mjs) instead of plain curl, since co-op needs a
# live connection to drive a fight.
#
# Covers the four round-3 fixes end to end, against an actual process
# boundary (a unit test calling the FightSession constructor directly
# proves the restore *logic*; this proves server/coop/ws.ts and
# server/coop/store.ts actually wire it together correctly):
#   1. legacy fight-row compatibility (no version/hp/ready, including a
#      mid-flight pendingFlee)
#   2. fight-id collision avoidance after a restart
#   3. a fled player is not re-locked into the fight they left
#   4. atomic fight-end persistence (victory + immediate restart: the
#      killed enemy stays dead)
#
# Not wired into CI: this job's own container uses a real named volume (not
# --tmpfs), and `docker restart` needs real time to actually stop/start the
# process — CI's `check` job instead runs tools/coop-live-check.mjs, which
# covers everything that doesn't need a real process boundary.
#   sh tools/coop-restart-check.sh
set -eu
IMG=comp4020-final-coop-restart
VOL=cc-coop-restart-$$
NAME=cc-coop-restart-$$
PORT=${PORT:-8096}
URL=http://localhost:$PORT
fail() { echo "  FAIL $*"; cleanup; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
up() {
  docker run -d --init --name "$NAME" -p "$PORT:8080" -e PORT=8080 -v "$VOL:/data" --memory=256m "$IMG" >/dev/null
  for _ in $(seq 1 50); do curl -s -o /dev/null "$URL/" && return; sleep 0.2; done
  fail "container did not answer"
}
restart() {
  docker restart "$NAME" >/dev/null
  for _ in $(seq 1 50); do curl -s -o /dev/null "$URL/" && return; sleep 0.2; done
  fail "container did not answer after restart"
}
# strips `version`/`hp`/`ready` from a room's first fight row, simulating one
# actually written by the code that existed between 3c658ca and b2896df.
strip_legacy_fields() {
  code=$1
  docker exec "$NAME" node --disable-warning=ExperimentalWarning -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/data/coop.sqlite");
    const row = db.prepare("SELECT data FROM fights WHERE room_code = ? AND fight_id = ?").get(process.argv[1], "f1");
    if (!row) { console.error("no fight row found for", process.argv[1]); process.exit(1); }
    const data = JSON.parse(row.data);
    delete data.version;
    for (const p of data.players) { delete p.hp; delete p.ready; }
    db.prepare("UPDATE fights SET data = ? WHERE room_code = ? AND fight_id = ?").run(JSON.stringify(data), process.argv[1], "f1");
  ' "$code"
}
run_node() { node tools/coop-restart-check.mjs "$@"; }

echo "# build"
docker build -q -t "$IMG" . >/dev/null
docker volume create "$VOL" >/dev/null
up

echo "# fix 2: fight-id collision — A fights f1, B is far away exploring"
fightid_state=$(run_node setup-fightid "$URL")

echo "# fix 3: a fled player must not be re-locked after a restart"
fled_state=$(run_node setup-fled "$URL")

echo "# fix 4: victory + immediate restart — the killed enemy must stay dead"
victory_state=$(run_node setup-victory "$URL")

echo "# fix 1: legacy fight-row compatibility"
legacy_state=$(run_node setup-legacy "$URL")
legacy_code=$(node -e 'console.log(JSON.parse(process.argv[1]).code)' "$legacy_state")
strip_legacy_fields "$legacy_code"

echo "# fix 1b: a legacy row with a mid-flight pendingFlee"
legacy_fled_state=$(run_node setup-legacy-fled "$URL")
legacy_fled_code=$(node -e 'console.log(JSON.parse(process.argv[1]).code)' "$legacy_fled_state")
strip_legacy_fields "$legacy_fled_code"

echo "# restart the container"
restart

echo "## verify: fight-id collision"
run_node verify-fightid "$URL" "$fightid_state" || fail "fight-id collision check failed"

echo "## verify: fled player not re-locked"
run_node verify-fled "$URL" "$fled_state" || fail "fled-player check failed"

echo "## verify: killed enemy stays dead"
run_node verify-victory "$URL" "$victory_state" || fail "victory-restart check failed"

echo "## verify: legacy fight-row compatibility"
run_node verify-legacy "$URL" "$legacy_state" || fail "legacy-compat check failed"

echo "## verify: legacy row with mid-flight pendingFlee"
run_node verify-legacy-fled "$URL" "$legacy_fled_state" || fail "legacy-pendingFlee check failed"

echo "# delete the container, rebuild the image, start fresh on the same volume (what a Fly redeploy does)"
docker rm -f "$NAME" >/dev/null
docker build -q --no-cache -t "$IMG" . >/dev/null
up
echo "## verify after rebuild + new container: killed enemy still stays dead"
run_node verify-victory "$URL" "$victory_state" || fail "victory check failed after rebuild"

cleanup
echo "coop restart checks passed"
