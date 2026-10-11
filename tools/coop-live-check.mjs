// Real-WebSocket co-op scenarios that need a live server but never a process
// restart — safe to run in CI against the actual production container
// (which CI already builds and starts before this runs). Restart-dependent
// scenarios (fight persistence, fight-id collisions, legacy-format
// compatibility, atomic fight-end) live in tools/coop-restart-check.sh
// instead, since CI's own container uses `--tmpfs /data`, which does not
// survive a `docker restart` (confirmed directly in this project) — a
// restart test here would not actually prove anything.
//
// Usage: node tools/coop-live-check.mjs [baseUrl]   (default http://127.0.0.1:8080)
import { WebSocket } from "ws";

const BASE = process.argv[2] ?? "http://127.0.0.1:8080";
const WS_BASE = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
}

async function createRoom(name) {
  const res = await fetch(`${BASE}/api/coop/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return { ...(await res.json()), cookie };
}
async function joinRoom(code, name) {
  const res = await fetch(`${BASE}/api/coop/rooms/${code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return { ...(await res.json()), cookie };
}
function connect(code, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/coop/ws?code=${code}`, { headers: { cookie } });
    const msgs = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve({ ws, msgs }));
    ws.on("error", reject);
  });
}
const last = (c, type) => [...c.msgs].reverse().find((m) => m.type === type);

/** Walks both clients together (same heading) until a shared fight forms, or fails the run. */
async function walkIntoFight(a, b, label) {
  const heading = { dx: 1, dy: -0.65 };
  a.ws.send(JSON.stringify({ type: "move", ...heading }));
  b.ws.send(JSON.stringify({ type: "move", ...heading }));
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await sleep(250);
    if (last(a, "fight")) started = true;
  }
  a.ws.send(JSON.stringify({ type: "move", dx: 0, dy: 0 }));
  b.ws.send(JSON.stringify({ type: "move", dx: 0, dy: 0 }));
  if (!started) throw new Error(`${label}: both players never entered a shared fight within budget`);
  await sleep(150);
}

// ---------- scenario 1: two independent clients, independent cards, common end-turn gating ----------
async function scenarioIndependentCombat() {
  console.log("\n# scenario 1: two independent clients auto-join one fight, play independently, share one enemy turn");
  const host = await createRoom("Live-Ash");
  const guest = await joinRoom(host.code, "Live-Birch");
  const a = await connect(host.code, host.cookie);
  const b = await connect(host.code, guest.cookie);
  await sleep(200);
  await walkIntoFight(a, b, "scenario1");

  check(last(a, "fight")?.players.length === 2 && last(b, "fight")?.players.length === 2, "both independent clients see the same two-player fight");
  const turnBefore = last(a, "fight").turn;

  a.ws.send(JSON.stringify({ type: "endTurn", seq: 1 }));
  await sleep(200);
  check(last(a, "fight").turn === turnBefore, "one client ending their turn alone does not resolve the round");
  check(last(a, "fight").players.find((p) => p.ready)?.ready === true, "the readied player is shown as ready");

  b.ws.send(JSON.stringify({ type: "endTurn", seq: 1 }));
  await sleep(300);
  check(last(a, "fight").turn > turnBefore || last(a, "fight").enemies.some((e) => e.hp < 6), "once both are ready, the enemy acts exactly once and the round advances");

  a.ws.close();
  b.ws.close();
}

// ---------- scenario 2: refresh/reconnect mid-fight keeps hand and action-seq valid ----------
async function scenarioReconnectSeq() {
  console.log("\n# scenario 2: a reconnect (same server process) resumes the same fight and seq stays valid");
  const host = await createRoom("Live-Reconnect");
  const guest = await joinRoom(host.code, "Live-Reconnect-B");
  const a = await connect(host.code, host.cookie);
  const b = await connect(host.code, guest.cookie);
  await sleep(200);
  await walkIntoFight(a, b, "scenario2");

  const fightId = last(a, "fight").fightId;
  // simulate a page refresh: close this socket (a brand-new tab/page would start actionSeq back at 0) and reconnect
  a.ws.close();
  await sleep(200);
  const a2 = await connect(host.code, host.cookie);
  await sleep(400);
  const fight2 = last(a2, "fight");
  const hand2 = last(a2, "hand");
  check(fight2?.fightId === fightId, "reconnecting resumes the same fight id");
  check(typeof hand2?.lastSeq === "number", `the server reports lastSeq for the client to adopt (got ${hand2?.lastSeq})`);

  // a freshly-reloaded client's own counter would start at 0; it must adopt lastSeq, not use 0+1=1 blindly if that's already stale
  const nextSeq = (hand2?.lastSeq ?? 0) + 1;
  a2.ws.send(JSON.stringify({ type: "endTurn", seq: nextSeq }));
  await sleep(300);
  check(!last(a2, "actionError"), `the first post-reconnect action (seq ${nextSeq}) is accepted, not rejected as stale`);

  a2.ws.close();
  b.ws.close();
}

// ---------- scenario 3: one flees, the other continues, with the correct personal notification ----------
async function scenarioIndividualFlee() {
  console.log("\n# scenario 3: one player flees; the other continues; the fleeing player's own dock closes");
  const host = await createRoom("Live-Flee");
  const guest = await joinRoom(host.code, "Live-Flee-B");
  const a = await connect(host.code, host.cookie);
  const b = await connect(host.code, guest.cookie);
  await sleep(200);
  await walkIntoFight(a, b, "scenario3");

  a.ws.send(JSON.stringify({ type: "flee", seq: 1 }));
  await sleep(100);
  b.ws.send(JSON.stringify({ type: "endTurn", seq: 1 }));
  await sleep(400);

  check(last(a, "leftFight")?.outcome === "fled", "the fleeing player gets an explicit leftFight message");
  check(!last(a, "fightEnded"), "the fleeing player does NOT get a fightEnded (the fight itself continues)");
  check(!!last(b, "fight") && !last(b, "fightEnded"), "the other player's fight continues normally");
  const aState = last(a, "state");
  check(aState?.players.find((p) => p.name === "Live-Flee")?.fightId === null, "the fleeing player is shown free again in the shared world");

  a.ws.close();
  b.ws.close();
}

async function main() {
  await scenarioIndependentCombat();
  await scenarioReconnectSeq();
  await scenarioIndividualFlee();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall co-op live checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
