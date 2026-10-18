import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LogEvent, LogSink } from "../log.ts";
import { FightSession } from "./fight-session.ts";
import { CoopRoom, type RoomFight } from "./room.ts";
import { openCoopStore, type CoopStore } from "./store.ts";
import { CoopServer } from "./ws.ts";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fight that's already won — session.ended is set, exactly the state afterFightChange sees. */
function setupEndedFight() {
  const room = new CoopRoom("ABC123", 0);
  room.addPlayer("p1", "Ash", "#fff", 0);
  const e = room.enemies.find((x) => x.key === "west-1")!;
  e.state = "engaged";
  e.fightId = "f1";
  e.hp = 6;
  room.players.get("p1")!.fightId = "f1";
  const roomFight: RoomFight = { id: "f1", anchorId: "p1", playerIds: ["p1"], enemyKeys: ["west-1"], startedAt: 0 };
  room.fights.set("f1", roomFight);
  const session = new FightSession(room, roomFight, rng(1));
  const strike = session.handView("p1")!.cards.find((c) => c.name === "Strike")!;
  const r = session.applyAction("p1", 1, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" }, 0, rng(2));
  expect(r.ok).toBe(true);
  expect(session.ended).toBe("won");
  return { room, session, initialMembers: ["p1"] };
}

/** Wraps a real CoopStore so finishFight can be made to fail on demand, then recover. */
function flakyStore(real: CoopStore): CoopStore & { failNext(n: number): void } {
  let failuresLeft = 0;
  return {
    ...real,
    failNext(n: number) {
      failuresLeft = n;
    },
    finishFight(code, fightId, json, now) {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("injected finishFight failure");
      }
      return real.finishFight(code, fightId, json, now);
    },
  };
}

describe("CoopServer: a finishFight failure must never falsely signal success", () => {
  it("does not send fightEnded, does not discard the session, and marks the fight pending", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = flakyStore(openCoopStore(dir));
    store.createRoom("ABC123", 0);
    const server = new CoopServer(dir, store);
    const { room, session, initialMembers } = setupEndedFight();

    store.failNext(1); // the one retry inside tryFinishFight also fails on this first attempt
    const sent = server.testRegisterFakeSocket("ABC123", "p1");
    server.testAfterFightChange(room, "f1", session, initialMembers);

    expect(sent.some((m) => m.type === "fightEnded")).toBe(false);
    expect(server.testPendingFinishCount()).toBe(1);

    server.close();
  });

  it("a room with a pending finish does not have its periodic snapshot diverge from the still-present fight row", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = flakyStore(openCoopStore(dir));
    store.createRoom("ABC123", 0);
    const server = new CoopServer(dir, store);
    const { room, session, initialMembers } = setupEndedFight();

    store.failNext(1);
    server.testRegisterFakeSocket("ABC123", "p1");
    server.testAfterFightChange(room, "f1", session, initialMembers);
    expect(server.testPendingFinishCount()).toBe(1);

    // simulate the fight row genuinely still sitting there, uncommitted (the failed attempt's
    // own transaction rolled back before ever reaching this point in the real store)
    store.putFight("ABC123", "f1", JSON.stringify({ marker: "still-here" }), 0);
    expect(store.fights("ABC123").some((f) => f.fightId === "f1")).toBe(true);

    // tickAll's own retry pass runs first and would otherwise resolve the pending finish
    // within this very tick — keep the fault alive through that retry too, so this check
    // actually observes the room's periodic-snapshot guard, not an incidental same-tick fix.
    store.failNext(1);
    server.testRegisterRoom(room);
    server.runTickForTest(); // must not write a room_state snapshot for this room while the finish is still pending
    expect(server.testPendingFinishCount()).toBe(1); // still pending: the retry above failed too
    expect(store.getState("ABC123")).toBeNull(); // no snapshot was ever written: skipped, not diverged

    server.close();
  });

  it("once the underlying fault clears, the next retry commits and notifies exactly once", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = flakyStore(openCoopStore(dir));
    store.createRoom("ABC123", 0);
    const server = new CoopServer(dir, store);
    const { room, session, initialMembers } = setupEndedFight();

    store.failNext(1);
    const sent = server.testRegisterFakeSocket("ABC123", "p1");
    server.testAfterFightChange(room, "f1", session, initialMembers);
    expect(sent.some((m) => m.type === "fightEnded")).toBe(false);
    expect(server.testPendingFinishCount()).toBe(1);

    // the fault has cleared (no more injected failures); a tick retries the pending finish
    server.testRegisterRoom(room);
    server.runTickForTest();

    const endedMsgs = sent.filter((m) => m.type === "fightEnded");
    expect(endedMsgs).toHaveLength(1); // exactly once, not duplicated
    expect(server.testPendingFinishCount()).toBe(0);
    expect(server.testHasSession("ABC123", "f1")).toBe(false);

    // a further tick must not re-send it
    server.runTickForTest();
    expect(sent.filter((m) => m.type === "fightEnded")).toHaveLength(1);

    server.close();
  });

  it("the happy path (no injected failure) still commits and notifies on the very first attempt, unchanged from before this mechanism existed", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    store.createRoom("ABC123", 0);
    const server = new CoopServer(dir, store);
    const { room, session, initialMembers } = setupEndedFight();

    const sent = server.testRegisterFakeSocket("ABC123", "p1");
    server.testAfterFightChange(room, "f1", session, initialMembers);

    expect(sent.filter((m) => m.type === "fightEnded")).toHaveLength(1);
    expect(server.testPendingFinishCount()).toBe(0);
    expect(store.fights("ABC123")).toHaveLength(0); // the fight row is really gone
    expect(store.getState("ABC123")).not.toBeNull(); // and the final room state was written

    server.close();
  });
});

/** Captures every LogEvent passed to it, in order, for exact assertions. */
function capturingSink(): LogSink & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  return { events, log: (e) => events.push(e) };
}

describe("CoopServer: business logging", () => {
  it("logs distinct, stable actor ids for two different identities doing the same thing", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    const log = capturingSink();
    const server = new CoopServer(dir, store, log);

    const a = await server.testHandleApi("POST", "/api/coop/rooms", { name: "Ash" });
    const code = (a.body as { code: string }).code;
    const b = await server.testHandleApi("POST", `/api/coop/rooms/${code}/join`, { name: "Ash" }, "cc_coop=" + "b".repeat(43));

    const creates = log.events.filter((e) => e.event === "coop.room.create");
    const joins = log.events.filter((e) => e.event === "coop.room.join");
    expect(creates).toHaveLength(1);
    expect(joins).toHaveLength(1);
    expect(creates[0].actorId).not.toBe(joins[0].actorId);
    expect(creates[0].actorId).toBeTruthy();
    expect(joins[0].actorId).toBeTruthy();
    // same display name, still different actor ids
    expect(creates[0].actorName).toBe("Ash");
    expect(joins[0].actorName).toBe("Ash");

    server.close();
  });

  it("the peek endpoint logs whether the room existed, without leaking member identities", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    const log = capturingSink();
    const server = new CoopServer(dir, store, log);

    const created = await server.testHandleApi("POST", "/api/coop/rooms", { name: "Ash" });
    const code = (created.body as { code: string }).code;

    const ok = await server.testHandleApi("GET", `/api/coop/rooms/${code}`, undefined);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ code, memberCount: 1 });

    const missing = await server.testHandleApi("GET", "/api/coop/rooms/ZZZZZZ", undefined);
    expect(missing.status).toBe(404);

    const peeks = log.events.filter((e) => e.event === "coop.room.peek");
    expect(peeks).toHaveLength(2);
    expect(peeks[0].result).toBe("ok");
    expect(peeks[1].result).toBe("rejected");
    expect(peeks[1].reason).toBe("no_such_room");

    server.close();
  });

  it.each([
    { setupSeq: 1, action: { type: "playCard", cardInstanceId: "not-a-real-card" }, expectReason: "card_not_in_hand" },
    { setupSeq: 0, action: { type: "endTurn" }, expectReason: "stale_seq" },
  ])("logs a stable reason code for a rejected action ($expectReason)", ({ setupSeq, action, expectReason }) => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    store.createRoom("ABC123", 0);
    const log = capturingSink();
    const server = new CoopServer(dir, store, log);
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#fff", 0);
    const e = room.enemies.find((x) => x.key === "west-1")!;
    e.state = "engaged";
    e.fightId = "f1";
    room.players.get("p1")!.fightId = "f1";
    const roomFight: RoomFight = { id: "f1", anchorId: "p1", playerIds: ["p1"], enemyKeys: ["west-1"], startedAt: 0 };
    room.fights.set("f1", roomFight);
    const session = new FightSession(room, roomFight, rng(1));
    server.testRegisterSession("ABC123", "f1", session);
    server.testRegisterFakeSocket("ABC123", "p1");

    if (setupSeq === 0) {
      // consume seq 1 first so a repeat of seq 1 below is genuinely stale
      session.applyAction("p1", 1, { type: "endTurn" }, 0, rng(2));
    }
    server.testHandleFightAction(room, "p1", 1, action);

    const rejections = log.events.filter((ev) => ev.event === "coop.action.rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toBe(expectReason);
    expect(rejections[0].actorId).toBeTruthy();
    // never leaks the attempted content
    expect(JSON.stringify(rejections[0])).not.toContain("not-a-real-card");

    server.close();
  });

  it("a rejected cross-player card attempt never logs the victim's hand content", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    store.createRoom("ABC123", 0);
    const log = capturingSink();
    const server = new CoopServer(dir, store, log);
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#fff", 0);
    room.addPlayer("p2", "Birch", "#000", 0);
    const e = room.enemies.find((x) => x.key === "west-1")!;
    e.state = "engaged";
    e.fightId = "f1";
    room.players.get("p1")!.fightId = "f1";
    room.players.get("p2")!.fightId = "f1";
    const roomFight: RoomFight = { id: "f1", anchorId: "p1", playerIds: ["p1", "p2"], enemyKeys: ["west-1"], startedAt: 0 };
    room.fights.set("f1", roomFight);
    const session = new FightSession(room, roomFight, rng(1));
    server.testRegisterSession("ABC123", "f1", session);
    server.testRegisterFakeSocket("ABC123", "p1");
    server.testRegisterFakeSocket("ABC123", "p2");

    const bCardId = session.handView("p2")!.cards[0].id;
    server.testHandleFightAction(room, "p1", 1, { type: "playCard", cardInstanceId: bCardId });

    const rejections = log.events.filter((ev) => ev.event === "coop.action.rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toBe("card_not_in_hand");
    // the stolen card id itself must never appear anywhere in the rejection log line
    expect(JSON.stringify(rejections[0])).not.toContain(bCardId);

    server.close();
  });

  it("a crafted display name produces exactly one valid JSON log line end to end", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    const log = capturingSink();
    const server = new CoopServer(dir, store, log);
    // room names are trimmed to NAME_MAX (24) by cleanName before this ever
    // reaches the logger — this payload fits within that bound so the test
    // exercises the real end-to-end path, not a hypothetical untruncated one.
    const XSS_NAME = `<img src=x o="y">`;

    await server.testHandleApi("POST", "/api/coop/rooms", { name: XSS_NAME });

    const created = log.events.find((e) => e.event === "coop.room.create")!;
    expect(created.actorName).toBe(XSS_NAME);
    // formatLogLine itself is unit-tested in server/log.test.ts; this confirms
    // ws.ts actually calls it with the real attacker-controlled value, not a
    // sanitized/pre-escaped copy that would hide a future regression.
    const { formatLogLine } = await import("../log.ts");
    const line = formatLogLine(created);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).actorName).toBe(XSS_NAME);

    server.close();
  });

  it("a successful card-play log carries the real card name, and a non-single card's garbage targetKey is never logged", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    store.createRoom("ABC123", 0);
    const log = capturingSink();
    const server = new CoopServer(dir, store, log);
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#fff", 0);
    const e = room.enemies.find((x) => x.key === "west-1")!;
    e.state = "engaged";
    e.fightId = "f1";
    room.players.get("p1")!.fightId = "f1";
    const roomFight: RoomFight = { id: "f1", anchorId: "p1", playerIds: ["p1"], enemyKeys: ["west-1"], startedAt: 0 };
    room.fights.set("f1", roomFight);
    const session = new FightSession(room, roomFight, rng(1));
    server.testRegisterSession("ABC123", "f1", session);
    server.testRegisterFakeSocket("ABC123", "p1");

    const guard = session.handView("p1")!.cards.find((c) => c.kind === "guard")!;
    const garbage = "x".repeat(2048);
    server.testHandleFightAction(room, "p1", 1, { type: "playCard", cardInstanceId: guard.id, targetKey: garbage });

    const cardLogs = log.events.filter((ev) => ev.event === "coop.fight.card");
    expect(cardLogs).toHaveLength(1);
    expect(cardLogs[0].summary?.cardName).toBe("Guard");
    expect(cardLogs[0].summary?.targetKey).toBeNull();
    expect(JSON.stringify(cardLogs[0])).not.toContain(garbage);

    server.close();
  });

  it("a legitimate single-target card play logs the real card name and the real target", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    store.createRoom("ABC123", 0);
    const log = capturingSink();
    const server = new CoopServer(dir, store, log);
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#fff", 0);
    const e = room.enemies.find((x) => x.key === "west-1")!;
    e.state = "engaged";
    e.fightId = "f1";
    e.hp = 999;
    room.players.get("p1")!.fightId = "f1";
    const roomFight: RoomFight = { id: "f1", anchorId: "p1", playerIds: ["p1"], enemyKeys: ["west-1"], startedAt: 0 };
    room.fights.set("f1", roomFight);
    const session = new FightSession(room, roomFight, rng(1));
    server.testRegisterSession("ABC123", "f1", session);
    server.testRegisterFakeSocket("ABC123", "p1");

    const strike = session.handView("p1")!.cards.find((c) => c.kind === "single")!;
    server.testHandleFightAction(room, "p1", 1, { type: "playCard", cardInstanceId: strike.id, targetKey: "west-1" });

    const cardLogs = log.events.filter((ev) => ev.event === "coop.fight.card");
    expect(cardLogs).toHaveLength(1);
    expect(cardLogs[0].summary?.cardName).toBe("Strike");
    expect(cardLogs[0].summary?.targetKey).toBe("west-1");

    server.close();
  });

  it("a downed player's reconnect-window timeout logs result:rejected, never a false success", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    store.createRoom("ABC123", 0);
    const log = capturingSink();
    const server = new CoopServer(dir, store, log);
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#fff", 0);
    room.addPlayer("p2", "Birch", "#000", 0);
    const e = room.enemies.find((x) => x.key === "west-1")!;
    e.state = "engaged";
    e.fightId = "f1";
    room.players.get("p1")!.fightId = "f1";
    room.players.get("p2")!.fightId = "f1";
    room.players.get("p1")!.online = false; // disconnected, matching the real reconnect-timeout precondition
    const roomFight: RoomFight = { id: "f1", anchorId: "p1", playerIds: ["p1", "p2"], enemyKeys: ["west-1"], startedAt: 0 };
    room.fights.set("f1", roomFight);
    const session = new FightSession(room, roomFight, rng(1));
    server.testRegisterSession("ABC123", "f1", session);
    server.testRegisterFakeSocket("ABC123", "p1");
    server.testRegisterFakeSocket("ABC123", "p2");
    // force p1 downed, the one real forceFlee-rejects case (fight-session.ts's "not an active member")
    session.fight.players.find((p) => p.id === "p1")!.downed = true;

    server.testHandleReconnectTimeout(room, "p1");

    const fleeLogs = log.events.filter((ev) => ev.event === "coop.fight.flee");
    expect(fleeLogs).toHaveLength(1);
    expect(fleeLogs[0].result).toBe("rejected");
    expect(fleeLogs[0].summary?.left).toBe(false);
    expect(fleeLogs[0].summary?.requested).toBe(true);
    // the player really is still downed and still in the fight: nothing was falsely resolved
    expect(room.players.get("p1")!.fightId).toBe("f1");

    server.close();
  });

  it("a normal (not downed) reconnect-window timeout still logs result:ok with summary.left true", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-coop-ws-"));
    const store = openCoopStore(dir);
    store.createRoom("ABC123", 0);
    const log = capturingSink();
    const server = new CoopServer(dir, store, log);
    const room = new CoopRoom("ABC123", 0);
    room.addPlayer("p1", "Ash", "#fff", 0);
    room.addPlayer("p2", "Birch", "#000", 0);
    const e = room.enemies.find((x) => x.key === "west-1")!;
    e.state = "engaged";
    e.fightId = "f1";
    room.players.get("p1")!.fightId = "f1";
    room.players.get("p2")!.fightId = "f1";
    room.players.get("p1")!.online = false;
    const roomFight: RoomFight = { id: "f1", anchorId: "p1", playerIds: ["p1", "p2"], enemyKeys: ["west-1"], startedAt: 0 };
    room.fights.set("f1", roomFight);
    const session = new FightSession(room, roomFight, rng(1));
    server.testRegisterSession("ABC123", "f1", session);
    server.testRegisterFakeSocket("ABC123", "p1");
    server.testRegisterFakeSocket("ABC123", "p2");

    server.testHandleReconnectTimeout(room, "p1");

    const fleeLogs = log.events.filter((ev) => ev.event === "coop.fight.flee");
    expect(fleeLogs).toHaveLength(1);
    expect(fleeLogs[0].result).toBe("ok");
    expect(fleeLogs[0].summary?.left).toBe(true);
    expect(fleeLogs[0].summary?.forced).toBe(true);

    server.close();
  });

});
