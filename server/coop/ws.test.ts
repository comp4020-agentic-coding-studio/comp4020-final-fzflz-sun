import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
