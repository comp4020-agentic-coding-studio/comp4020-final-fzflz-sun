#!/bin/sh
# Builds the production image, saves a checkpoint for two visitors, then
# checks both saves survive (1) a container restart and (2) deleting the
# container and starting a fresh one from a rebuilt image on the same volume,
# which is what a Fly redeploy does with the /data volume.
#   sh tools/persistence-check.sh
set -eu
IMG=comp4020-final-persist
VOL=cc-persist-$$
NAME=cc-persist-$$
PORT=${PORT:-8095}
URL=http://localhost:$PORT
A=$(mktemp) B=$(mktemp)
fail() { echo "  FAIL $*"; cleanup; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; rm -f "$A" "$B"; }
up() {
  docker run -d --init --name "$NAME" -p "$PORT:8080" -e PORT=8080 -v "$VOL:/data" --memory=256m "$IMG" >/dev/null
  for _ in $(seq 1 50); do curl -s -o /dev/null "$URL/" && return; sleep 0.2; done
  fail "container did not answer"
}
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(eval(process.argv[1]))})' "$1"; }

echo "# build"
docker build -q -t "$IMG" . >/dev/null
docker volume create "$VOL" >/dev/null
up

echo "# two visitors save different progress"
for jar in "$A" "$B"; do
  curl -s -c "$jar" -b "$jar" -X POST -H 'content-type: application/json' -d '{"baseRevision":0}' "$URL/api/runs" > "$jar.run"
done
# visitor A kills west-1; visitor B is wounded
body=$(json '(()=>{j.save.enemies["west-1"]=0;delete j.save.places["west-1"];j.save.stats.kills=1;j.save.stats.wins=1;j.save.stats.fights=1;j.save.reason="victory";j.save.savedAt+=5;return JSON.stringify({baseRevision:j.revision,save:j.save})})()' < "$A.run")
curl -s -f -c "$A" -b "$A" -X PUT -H 'content-type: application/json' -d "$body" "$URL/api/save" >/dev/null || fail "save A rejected"
body=$(json '(()=>{j.save.player.hp=9;j.save.reason="flee";j.save.stats.fights=1;j.save.stats.flees=1;j.save.savedAt+=5;return JSON.stringify({baseRevision:j.revision,save:j.save})})()' < "$B.run")
curl -s -f -c "$B" -b "$B" -X PUT -H 'content-type: application/json' -d "$body" "$URL/api/save" >/dev/null || fail "save B rejected"
rm -f "$A.run" "$B.run"

check() {
  a=$(curl -s -b "$A" "$URL/api/save" | json 'j.save && j.save.enemies["west-1"]+","+j.save.player.hp+","+j.save.reason')
  b=$(curl -s -b "$B" "$URL/api/save" | json 'j.save && j.save.enemies["west-1"]+","+j.save.player.hp+","+j.save.reason')
  [ "$a" = "0,24,victory" ] || fail "$1: visitor A has $a, expected 0,24,victory"
  [ "$b" = "6,9,flee" ] || fail "$1: visitor B has $b, expected 6,9,flee"
  echo "  ok   $1: A=$a  B=$b"
}
check "before restart"

echo "# restart the container"
docker restart "$NAME" >/dev/null
for _ in $(seq 1 50); do curl -s -o /dev/null "$URL/" && break; sleep 0.2; done
check "after restart"

echo "# delete the container, rebuild the image, start fresh on the same volume"
docker rm -f "$NAME" >/dev/null
docker build -q --no-cache -t "$IMG" . >/dev/null
up
check "after rebuild + new container"

echo "# a save written by the v1 game, planted on the volume, loads as v2"
C=$(mktemp)
curl -s -c "$C" -b "$C" "$URL/api/save" >/dev/null
token=$(awk '$6 == "cc_visitor" { print $7 }' "$C")
vid=$(node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$token")
v1='{"v":1,"runId":"run_oldsave1","runNumber":2,"startedAt":1700000000000,"savedAt":1700000100000,"reason":"victory","outcome":"playing","player":{"hp":13,"x":900,"y":500},"enemies":{"west-1":0,"west-2":0,"south-1":4,"north-1":6,"north-2":6,"north-3":6,"lair-guard":6,"lair-boss":40},"stats":{"fights":3,"wins":2,"flees":1,"kills":2}}'
docker exec "$NAME" node --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/data/game.sqlite");
  db.prepare("INSERT INTO saves (visitor_id, revision, data, updated_at) VALUES (?, 1, ?, ?)").run(process.argv[1], process.argv[2], Date.now());
' "$vid" "$v1"
c=$(curl -s -b "$C" "$URL/api/save" | json 'j.save.v+","+j.save.enemies["west-1"]+","+j.save.enemies["south-1"]+","+j.save.enemies["north-mage"]+","+j.save.player.hp+","+JSON.stringify(j.save.phases)')
rm -f "$C"
[ "$c" = '2,0,4,9,13,{"ridge-captain":0,"lair-boss":0}' ] || fail "v1 save loaded as $c"
echo "  ok   v1 save -> $c"

cleanup
echo "persistence checks passed"
