// Companion script for tools/coop-restart-check.sh: real WebSocket scenarios
// around an actual process restart. Each "setup" phase runs before the
// restart and prints JSON state to stdout for the shell script to pass back
// in; each "verify" phase runs after the restart and checks real behavior,
// exiting non-zero on any failure. Kept as one file with named phases
// (rather than N one-off scripts) since every phase shares the same small
// WebSocket-client helpers.
import { WebSocket } from "ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.error(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
}
function finish() {
  console.error(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

function wsBase(httpBase) {
  return httpBase.replace(/^http/, "ws");
}
async function createRoom(base, name) {
  const res = await fetch(`${base}/api/coop/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return { ...(await res.json()), cookie };
}
async function joinRoom(base, code, name) {
  const res = await fetch(`${base}/api/coop/rooms/${code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return { ...(await res.json()), cookie };
}
function connect(base, code, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase(base)}/coop/ws?code=${code}`, { headers: { cookie } });
    const msgs = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve({ ws, msgs }));
    ws.on("error", reject);
  });
}
const last = (c, type) => [...c.msgs].reverse().find((m) => m.type === type);

async function walkIntoFight(a, b, heading = { dx: 1, dy: -0.65 }) {
  a.ws.send(JSON.stringify({ type: "move", ...heading }));
  b.ws.send(JSON.stringify({ type: "move", ...heading }));
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await sleep(250);
    if (last(a, "fight")) started = true;
  }
  a.ws.send(JSON.stringify({ type: "move", dx: 0, dy: 0 }));
  b.ws.send(JSON.stringify({ type: "move", dx: 0, dy: 0 }));
  if (!started) throw new Error("both players never entered a shared fight within budget");
  await sleep(150);
}
async function steerToward(base, code, cookie, target, maxIters = 40) {
  const c = await connect(base, code, cookie);
  for (let i = 0; i < maxIters; i++) {
    const st = last(c, "state");
    let dx = 0, dy = 0;
    if (st) {
      const me = st.players.find((p) => p.fightId === null || p.fightId === undefined);
      if (me) {
        dx = target.x - me.x;
        dy = target.y - me.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
      }
    }
    c.ws.send(JSON.stringify({ type: "move", dx, dy }));
    await sleep(300);
    if (last(c, "fight")) return c;
  }
  return c;
}

// ---------- fight-id collision: A fights f1; B is far away ----------
async function setupFightId(base) {
  const host = await createRoom(base, "RC-FightId-A");
  const guest = await joinRoom(base, host.code, "RC-FightId-B");
  const a = await connect(base, host.code, host.cookie);
  const b = await connect(base, host.code, guest.cookie);
  await sleep(200);
  a.ws.send(JSON.stringify({ type: "move", dx: 1, dy: -0.65 }));
  b.ws.send(JSON.stringify({ type: "move", dx: -1, dy: 1 }));
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await sleep(250);
    if (last(a, "fight")) started = true;
  }
  a.ws.send(JSON.stringify({ type: "move", dx: 0, dy: 0 }));
  b.ws.send(JSON.stringify({ type: "move", dx: 0, dy: 0 }));
  if (!started) throw new Error("setupFightId: A never entered a fight");
  await sleep(300);
  const state = { code: host.code, cookies: { a: host.cookie, b: guest.cookie }, aFightId: last(a, "fight").fightId };
  a.ws.close();
  b.ws.close();
  console.log(JSON.stringify(state));
}
async function verifyFightId(base, state) {
  const a = await connect(base, state.code, state.cookies.a);
  await sleep(400);
  check(last(a, "fight")?.fightId === state.aFightId, `A's fight resumed with the same id (${state.aFightId})`);

  const b = await steerToward(base, state.code, state.cookies.b, { x: 1950, y: 615 }); // lair-boss's spawn
  const bFight = last(b, "fight");
  check(!!bFight, "B triggers a brand new fight after the restart");
  check(bFight?.fightId !== state.aFightId, `B's new fight has a different id than A's resumed fight (A=${state.aFightId}, B=${bFight?.fightId})`);

  const aFightAfter = last(a, "fight");
  check(aFightAfter?.fightId === state.aFightId, "A's fight is unaffected by B's new fight forming");
  a.ws.close();
  b.ws.close();
}

// ---------- fled player not re-locked ----------
async function setupFled(base) {
  const host = await createRoom(base, "RC-Fled-A");
  const guest = await joinRoom(base, host.code, "RC-Fled-B");
  const a = await connect(base, host.code, host.cookie);
  const b = await connect(base, host.code, guest.cookie);
  await sleep(200);
  await walkIntoFight(a, b);
  const fightId = last(a, "fight").fightId;
  a.ws.send(JSON.stringify({ type: "flee", seq: 1 }));
  await sleep(100);
  b.ws.send(JSON.stringify({ type: "endTurn", seq: 1 }));
  await sleep(400);
  const state = { code: host.code, cookies: { a: host.cookie, b: guest.cookie }, fightId };
  a.ws.close();
  b.ws.close();
  console.log(JSON.stringify(state));
}
async function verifyFled(base, state) {
  const a = await connect(base, state.code, state.cookies.a);
  await sleep(500);
  check(!last(a, "fight"), "A (who'd fled before the restart) gets no fight view on reconnect");
  const aMe = last(a, "state")?.players.find((p) => p.name === "RC-Fled-A");
  check(aMe?.fightId === null, `A's fightId is null, not re-locked — got ${aMe?.fightId}`);
  a.ws.send(JSON.stringify({ type: "move", dx: 1, dy: 0 }));
  await sleep(300);
  const after = [...a.msgs].reverse().find((m) => m.type === "state")?.players.find((p) => p.name === "RC-Fled-A");
  check(after?.x > aMe.x, "A can move freely (not frozen as if still fighting)");

  const b = await connect(base, state.code, state.cookies.b);
  await sleep(500);
  const bFight = last(b, "fight");
  check(bFight?.fightId === state.fightId, "B's fight resumed with the same id");
  const bInView = bFight?.players.find((p) => p.hp === 24);
  check(bInView?.fled === false, "B is shown correctly as still active");
  a.ws.close();
  b.ws.close();
}

// ---------- victory + immediate restart: killed enemy stays dead ----------
async function setupVictory(base) {
  const host = await createRoom(base, "RC-Victory-A");
  const a = await connect(base, host.code, host.cookie);
  await sleep(200);
  a.ws.send(JSON.stringify({ type: "move", dx: 1, dy: -0.65 }));
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await sleep(250);
    if (last(a, "fight")) started = true;
  }
  if (!started) throw new Error("setupVictory: never entered a fight");
  await sleep(150);
  const enemyKey = last(a, "fight").enemies[0].key;
  const enemyHp = last(a, "fight").enemies[0].hp;
  const hand = last(a, "hand");
  const strike = hand.cards.find((c) => c.name === "Strike");
  if (!strike || strike.value < enemyHp) throw new Error(`can't reliably one-shot (hp=${enemyHp}, strike=${strike?.value})`);
  a.ws.send(JSON.stringify({ type: "playCard", seq: 1, cardInstanceId: strike.id, targetKey: enemyKey }));
  await sleep(400);
  const state = { code: host.code, enemyKey };
  a.ws.close();
  console.log(JSON.stringify(state));
}
async function verifyVictory(base, state) {
  const res = await fetch(`${base}/api/coop/rooms/${state.code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "RC-Victory-Observer" }) });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const b = await connect(base, state.code, cookie);
  await sleep(500);
  const still = last(b, "state")?.enemies.find((e) => e.id === state.enemyKey);
  check(!still, `the killed enemy ("${state.enemyKey}") did not come back after a restart`);
  b.ws.close();
}

// ---------- legacy fight-row compatibility ----------
async function setupLegacy(base) {
  const host = await createRoom(base, "RC-Legacy-A");
  const guest = await joinRoom(base, host.code, "RC-Legacy-B");
  const a = await connect(base, host.code, host.cookie);
  const b = await connect(base, host.code, guest.cookie);
  await sleep(200);
  await walkIntoFight(a, b);
  // play a non-attack card so the fight stays open (avoid one-shotting west-1)
  const hand1 = last(a, "hand");
  const card = hand1.cards.find((c) => c.kind !== "single") ?? hand1.cards[0];
  a.ws.send(JSON.stringify({ type: "playCard", seq: 1, cardInstanceId: card.id, targetKey: card.kind === "single" ? last(a, "fight").enemies[0].key : undefined }));
  await sleep(300);
  const state = { code: host.code, cookies: { a: host.cookie, b: guest.cookie } };
  a.ws.close();
  b.ws.close();
  console.log(JSON.stringify(state));
}
async function verifyLegacy(base, state) {
  const a = await connect(base, state.code, state.cookies.a);
  await sleep(500);
  const fight = last(a, "fight");
  const hand = last(a, "hand");
  check(!!fight, "the legacy-shaped fight loads at all");
  check(typeof fight?.enemies[0]?.hp === "number" && Number.isFinite(fight.enemies[0].hp), "enemy HP is a real finite number");
  const myHp = fight?.players.find((p) => p.id)?.hp;
  check(typeof myHp === "number" && Number.isFinite(myHp) && myHp > 0, `player HP is valid, not undefined/NaN (got ${myHp})`);
  check(typeof hand?.energy === "number" && Number.isFinite(hand.energy), `energy is valid (got ${hand?.energy})`);
  a.seq = (hand?.lastSeq ?? 0) + 1;
  a.ws.send(JSON.stringify({ type: "endTurn", seq: a.seq }));
  await sleep(300);
  check(!last(a, "actionError"), "normal play continues after migration");
  const b = await connect(base, state.code, state.cookies.b);
  await sleep(500);
  check(!!last(b, "fight"), "the teammate also resumes into the same migrated fight");
  a.ws.close();
  b.ws.close();
}

// ---------- legacy row with a mid-flight pendingFlee ----------
async function setupLegacyFled(base) {
  const host = await createRoom(base, "RC-LegacyFlee-A");
  const guest = await joinRoom(base, host.code, "RC-LegacyFlee-B");
  const a = await connect(base, host.code, host.cookie);
  const b = await connect(base, host.code, guest.cookie);
  await sleep(200);
  await walkIntoFight(a, b);
  a.ws.send(JSON.stringify({ type: "flee", seq: 1 })); // B deliberately never acts: round stays unresolved
  await sleep(400);
  const state = { code: host.code, cookies: { a: host.cookie, b: guest.cookie } };
  a.ws.close();
  b.ws.close();
  console.log(JSON.stringify(state));
}
async function verifyLegacyFled(base, state) {
  const a = await connect(base, state.code, state.cookies.a);
  await sleep(500);
  const fight = last(a, "fight");
  check(!!fight, "the migrated fight (with a mid-flight pendingFlee) loads");
  const aView = fight?.players.find((p) => !p.fled);
  check(aView?.ready === true, `A (who'd clicked flee pre-restart) is restored as ready — got ${aView?.ready}`);
  const hand = last(a, "hand");
  a.seq = (hand?.lastSeq ?? 0) + 1;
  a.ws.send(JSON.stringify({ type: "playCard", seq: a.seq, cardInstanceId: hand?.cards?.[0]?.id }));
  await sleep(300);
  check(!!last(a, "actionError"), "A cannot play another card: already committed to flee before the restart");
  a.ws.close();
}

// ---------- card-instance-id collision across a restart (two concurrent rooms) ----------
/**
 * Plays Focus (resource) cards repeatedly to push this room's dealt card ids
 * well past where a fresh process's counter would start (1) after a
 * restart, so a collision would be detectable. The 14-card deck only has 3
 * Focus cards, so a hand can run dry of them mid-loop — in that case this
 * ends its own turn instead of stalling, so the next round's fresh deal gets
 * more chances to draw one, keeping the final post-restart hand likely to
 * contain one for the decisive new-id-collision check in verifyCardId.
 */
async function churnCardIds(c, otherC, rounds) {
  for (let i = 0; i < rounds; i++) {
    const hand = last(c, "hand");
    if (!hand) break;
    const focus = hand.cards.find((card) => card.kind === "resource");
    if (focus) {
      c.ws.send(JSON.stringify({ type: "playCard", seq: (c.seq = (c.seq ?? 0) + 1), cardInstanceId: focus.id }));
      await sleep(150);
    } else {
      // no Focus left this round: end the turn (both players, so the round actually
      // resolves) to get a fresh deal next round with another chance to draw one.
      c.ws.send(JSON.stringify({ type: "endTurn", seq: (c.seq = (c.seq ?? 0) + 1) }));
      otherC.ws.send(JSON.stringify({ type: "endTurn", seq: (otherC.seq = (otherC.seq ?? 0) + 1) }));
      await sleep(250);
    }
  }
}
function allCardIds(hand) {
  return hand?.cards.map((card) => card.id) ?? [];
}

async function setupCardId(base) {
  // two SEPARATE rooms, each with its own fight — the shared card-id counter is process-wide,
  // so a fix that only reserved ids within one room's own restore would still collide here.
  const hostA = await createRoom(base, "RC-CardId-A1");
  const guestA = await joinRoom(base, hostA.code, "RC-CardId-A2");
  const a1 = await connect(base, hostA.code, hostA.cookie);
  const a2 = await connect(base, hostA.code, guestA.cookie);
  await sleep(200);
  await walkIntoFight(a1, a2);
  await churnCardIds(a1, a2, 8);

  const hostB = await createRoom(base, "RC-CardId-B1");
  const guestB = await joinRoom(base, hostB.code, "RC-CardId-B2");
  const b1 = await connect(base, hostB.code, hostB.cookie);
  const b2 = await connect(base, hostB.code, guestB.cookie);
  await sleep(200);
  await walkIntoFight(b1, b2);
  await churnCardIds(b1, b2, 8);

  const state = {
    roomA: { code: hostA.code, cookies: { a: hostA.cookie, b: guestA.cookie }, handIdsBefore: allCardIds(last(a1, "hand")) },
    roomB: { code: hostB.code, cookies: { a: hostB.cookie, b: guestB.cookie }, handIdsBefore: allCardIds(last(b1, "hand")) },
  };
  for (const c of [a1, a2, b1, b2]) c.ws.close();
  console.log(JSON.stringify(state));
}
async function verifyCardId(base, state) {
  const roomA = await connect(base, state.roomA.code, state.roomA.cookies.a);
  const roomB = await connect(base, state.roomB.code, state.roomB.cookies.a);
  await sleep(500);

  const handAAfter = last(roomA, "hand");
  const handBAfter = last(roomB, "hand");
  check(!!handAAfter && !!handBAfter, "both rooms' fights resumed with a real hand after the restart");
  check(JSON.stringify(allCardIds(handAAfter)) === JSON.stringify(state.roomA.handIdsBefore), "room A's restored hand kept its exact prior card instance ids");
  check(JSON.stringify(allCardIds(handBAfter)) === JSON.stringify(state.roomB.handIdsBefore), "room B's restored hand kept its exact prior card instance ids");

  // now draw a BRAND NEW card in room A (via Focus, if available) and confirm its id collides
  // with NOTHING already in use — not room A's own restored hand, and not room B's either,
  // since the counter that must be advanced past both is process-wide, not per-room.
  const everyPriorId = new Set([...state.roomA.handIdsBefore, ...state.roomB.handIdsBefore]);
  const focusA = handAAfter?.cards.find((c) => c.kind === "resource");
  if (focusA) {
    roomA.ws.send(JSON.stringify({ type: "playCard", seq: 1, cardInstanceId: focusA.id }));
    await sleep(400);
    const handAFinal = last(roomA, "hand");
    const newIds = allCardIds(handAFinal).filter((id) => id !== focusA.id && !state.roomA.handIdsBefore.includes(id));
    check(newIds.length > 0, "a brand-new card id was actually generated by the post-restart Focus draw");
    for (const id of newIds) check(!everyPriorId.has(id), `the newly-generated card id (${id}) does not collide with any id already in use in either room`);
    check(!last(roomA, "actionError"), "the post-restart Focus play was accepted cleanly, no action error");
  } else {
    console.log("  (room A's restored hand has no Focus card to draw with post-restart — the id-reservation fix is still exercised by the exact-match checks above)");
  }

  roomA.ws.close();
  roomB.ws.close();
}

const PHASES = {
  "setup-fightid": setupFightId,
  "verify-fightid": verifyFightId,
  "setup-fled": setupFled,
  "verify-fled": verifyFled,
  "setup-victory": setupVictory,
  "verify-victory": verifyVictory,
  "setup-legacy": setupLegacy,
  "verify-legacy": verifyLegacy,
  "setup-legacy-fled": setupLegacyFled,
  "verify-legacy-fled": verifyLegacyFled,
  "setup-cardid": setupCardId,
  "verify-cardid": verifyCardId,
};

async function main() {
  const [, , phase, base, stateJson] = process.argv;
  const fn = PHASES[phase];
  if (!fn) {
    console.error(`unknown phase "${phase}". Known: ${Object.keys(PHASES).join(", ")}`);
    process.exit(1);
  }
  await fn(base, stateJson ? JSON.parse(stateJson) : undefined);
  if (phase.startsWith("verify-")) finish();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
