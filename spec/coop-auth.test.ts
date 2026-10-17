import { WebSocket } from "ws";
import { describe, expect, inject, it } from "vitest";

// Checks against the RUNNING app (spec/global-setup.ts finds it) proving the
// authorization boundaries docs/adr/0007-coop-identity-and-permissions.md
// documents: identity is server-derived and never client-suppliable, a
// non-member can't open a room's socket, a player can never read or change
// another player's private state, and a rejected action never has a side
// effect. HTTP/WebSocket-level, not a browser — see
// tools/coop-identity-demo-check.mjs for the real-browser, two-profile
// mechanical demo stand-in.
const baseUrl = inject("baseUrl");
const wsBase = baseUrl.replace(/^http/, "ws");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal cookie-jar client: one instance = one anonymous co-op identity. */
function identity() {
  let cookie = "";
  return {
    cookie: () => cookie,
    call: async (method: string, path: string, body?: unknown) => {
      const res = await fetch(new URL(path, baseUrl), {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      let json: any = null;
      try {
        json = await res.json();
      } catch {
        // some responses (e.g. a bare socket-level rejection) have no JSON body
      }
      return { status: res.status, body: json };
    },
  };
}

async function createRoom(api: ReturnType<typeof identity>, name: string) {
  const r = await api.call("POST", "/api/coop/rooms", { name });
  expect(r.status).toBe(200);
  return r.body as { code: string; name: string; color: string };
}

async function joinRoom(api: ReturnType<typeof identity>, code: string, name: string) {
  const r = await api.call("POST", `/api/coop/rooms/${code}/join`, { name });
  expect(r.status).toBe(200);
  return r.body as { code: string; name: string; color: string; members: { id: string; name: string; color: string }[] };
}

/** Opens a real WebSocket as the given identity's cookie and resolves with every message received so far, plus a send helper. Rejects (or the caller should race a timeout) if the server never upgrades. */
function connect(code: string, cookie: string): Promise<{ ws: WebSocket; msgs: any[]; send: (m: unknown) => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/coop/ws?code=${code}`, { headers: { cookie } });
    const msgs: any[] = [];
    let settled = false;
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => {
      if (settled) return;
      settled = true;
      resolve({ ws, msgs, send: (m: unknown) => ws.send(JSON.stringify(m)) });
    });
    ws.on("unexpected-response", (_req, res) => {
      if (settled) return;
      settled = true;
      reject(new Error(`upgrade rejected: ${res.statusCode}`));
    });
    ws.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

const last = (c: { msgs: any[] }, type: string) => [...c.msgs].reverse().find((m) => m.type === type);

/** Walks both clients together until a shared fight forms, then stops them. */
async function walkIntoFight(a: Awaited<ReturnType<typeof connect>>, b: Awaited<ReturnType<typeof connect>>) {
  const heading = { dx: 1, dy: -0.65 };
  a.send({ type: "move", ...heading });
  b.send({ type: "move", ...heading });
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await sleep(250);
    if (last(a, "fight")) started = true;
  }
  a.send({ type: "move", dx: 0, dy: 0 });
  b.send({ type: "move", dx: 0, dy: 0 });
  if (!started) throw new Error("both players never entered a shared fight within budget");
  await sleep(150);
}

describe("coop identity and authorization", () => {
  it("two identities with the same display name get different, stable ids", async () => {
    const apiA = identity();
    const apiB = identity();
    const roomA = await createRoom(apiA, "Twin");
    const roomB = await joinRoom(apiB, roomA.code, "Twin");
    // host and guest both chose the same display name; the server must still
    // have assigned them two different member ids.
    expect(roomB.members.every((m) => m.name === "Twin")).toBe(true);
    const ids = roomB.members.map((m) => m.id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("reconnecting with the same cookie keeps the same identity", async () => {
    const api = identity();
    const room = await createRoom(api, "Reconnector");
    const conn1 = await connect(room.code, api.cookie());
    await sleep(100);
    const selfId1 = last(conn1, "hello")?.selfId;
    expect(selfId1).toBeTruthy();
    conn1.ws.close();
    await sleep(100);
    const conn2 = await connect(room.code, api.cookie());
    await sleep(100);
    const selfId2 = last(conn2, "hello")?.selfId;
    expect(selfId2).toBe(selfId1);
    conn2.ws.close();
  });

  it("the peek endpoint reveals existence but no member identities", async () => {
    const api = identity();
    const room = await createRoom(api, "Peeker");
    // no cookie at all: a fresh, uninvolved prober
    const prober = identity();
    const r = await prober.call("GET", `/api/coop/rooms/${room.code}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("code", room.code);
    expect(r.body).toHaveProperty("memberCount");
    expect(r.body).not.toHaveProperty("members");
  });

  it("a non-member cannot open this room's WebSocket", async () => {
    const api = identity();
    const room = await createRoom(api, "Gatekept");
    const outsider = identity();
    // establish an identity cookie without ever joining this room
    await outsider.call("GET", `/api/coop/rooms/${room.code}`);
    await expect(connect(room.code, outsider.cookie())).rejects.toThrow();
  });

  it("a valid invite-link join (code only) succeeds and both sides see each other", async () => {
    const apiA = identity();
    const apiB = identity();
    const room = await createRoom(apiA, "Inviter");
    const joined = await joinRoom(apiB, room.code, "Invitee");
    expect(joined.members.some((m) => m.name === "Invitee")).toBe(true);
    expect(joined.members.some((m) => m.name === "Inviter")).toBe(true);
  });

  it("naming another player's id in a move message never moves them, only the sender", async () => {
    const apiA = identity();
    const apiB = identity();
    const room = await createRoom(apiA, "Mover-A");
    await joinRoom(apiB, room.code, "Mover-B");
    const a = await connect(room.code, apiA.cookie());
    const b = await connect(room.code, apiB.cookie());
    await sleep(200);
    const aId = last(a, "hello").selfId;
    const bId = last(b, "hello").selfId;
    await sleep(150);
    const stateBefore = last(a, "state");
    const aBefore = stateBefore.players.find((p: any) => p.id === aId);
    const bBefore = stateBefore.players.find((p: any) => p.id === bId);

    // forge a playerId field alongside a real move — the server has no such
    // field in its protocol, so this proves it's silently ignored, not that
    // it errors. The only identity that can ever move is the one actually
    // sending on this socket.
    a.send({ type: "move", dx: 1, dy: 0, playerId: bId });
    await sleep(400);
    a.send({ type: "move", dx: 0, dy: 0 });
    await sleep(150);

    const stateAfter = last(a, "state");
    const aAfter = stateAfter.players.find((p: any) => p.id === aId);
    const bAfter = stateAfter.players.find((p: any) => p.id === bId);
    // A, the real sender, actually moved
    expect(Math.hypot(aAfter.x - aBefore.x, aAfter.y - aBefore.y)).toBeGreaterThan(10);
    // B did not move at all despite A naming B's id
    expect(bAfter.x).toBeCloseTo(bBefore.x, 5);
    expect(bAfter.y).toBeCloseTo(bBefore.y, 5);
    a.ws.close();
    b.ws.close();
  });

  it("using another player's card instance id is rejected and leaves their hand/energy unchanged", async () => {
    const apiA = identity();
    const apiB = identity();
    const room = await createRoom(apiA, "Card-A");
    await joinRoom(apiB, room.code, "Card-B");
    const a = await connect(room.code, apiA.cookie());
    const b = await connect(room.code, apiB.cookie());
    await sleep(200);
    await walkIntoFight(a, b);

    const handB = last(b, "hand");
    expect(handB).toBeTruthy();
    const bCardId = handB.cards[0].id;
    const bEnergyBefore = handB.energy;
    const bHandCountBefore = handB.cards.length;

    a.send({ type: "playCard", seq: 1, cardInstanceId: bCardId });
    await sleep(300);

    const aError = last(a, "actionError");
    expect(aError).toBeTruthy();
    expect(aError.error).toMatch(/isn't in your hand|stale/i);

    // B's own state, read from B's own socket, is untouched
    const bHandAfter = last(b, "hand");
    expect(bHandAfter.energy).toBe(bEnergyBefore);
    expect(bHandAfter.cards.length).toBe(bHandCountBefore);
    expect(bHandAfter.cards.some((c: any) => c.id === bCardId)).toBe(true);

    a.ws.close();
    b.ws.close();
  });

  it("a player never receives another player's hand message", async () => {
    const apiA = identity();
    const apiB = identity();
    const room = await createRoom(apiA, "Hand-A");
    await joinRoom(apiB, room.code, "Hand-B");
    const a = await connect(room.code, apiA.cookie());
    const b = await connect(room.code, apiB.cookie());
    await sleep(200);
    await walkIntoFight(a, b);

    const bHand = last(b, "hand");
    expect(bHand).toBeTruthy();
    const bCardIds = new Set(bHand.cards.map((c: any) => c.id));

    // every "hand" message A ever received must be A's own (same fightId,
    // and never containing exactly B's card id set with B's never having
    // been sent to A at all — the real proof is structural: A's hand
    // messages' card ids must never equal B's).
    const aHandMsgs = a.msgs.filter((m) => m.type === "hand");
    expect(aHandMsgs.length).toBeGreaterThan(0);
    for (const h of aHandMsgs) {
      const ids = h.cards.map((c: any) => c.id);
      expect(ids.some((id: string) => bCardIds.has(id))).toBe(false);
    }

    a.ws.close();
    b.ws.close();
  });

  it("after a rejected action, the legitimate player can still act normally", async () => {
    const apiA = identity();
    const apiB = identity();
    const room = await createRoom(apiA, "Recover-A");
    await joinRoom(apiB, room.code, "Recover-B");
    const a = await connect(room.code, apiA.cookie());
    const b = await connect(room.code, apiB.cookie());
    await sleep(200);
    await walkIntoFight(a, b);

    // A sends a malformed/adversarial action first
    const handB = last(b, "hand");
    a.send({ type: "playCard", seq: 1, cardInstanceId: handB.cards[0].id });
    await sleep(200);
    expect(last(a, "actionError")).toBeTruthy();

    // B's own, legitimate action still succeeds afterward
    const bEnergyBefore = handB.energy;
    const bHandCountBefore = handB.cards.length;
    const affordable = handB.cards.find((c: any) => c.cost <= handB.energy && c.kind !== "single");
    expect(affordable).toBeTruthy();
    const errorCountBefore = b.msgs.filter((m) => m.type === "actionError").length;
    b.send({ type: "playCard", seq: 1, cardInstanceId: affordable.id });
    await sleep(300);
    const bHandAfter = last(b, "hand");
    expect(bHandAfter.energy).toBe(bEnergyBefore - affordable.cost + (affordable.kind === "resource" ? 1 : 0));
    expect(bHandAfter.cards.length).toBe(affordable.kind === "resource" ? bHandCountBefore : bHandCountBefore - 1);
    expect(b.msgs.filter((m) => m.type === "actionError").length).toBe(errorCountBefore);

    a.ws.close();
    b.ws.close();
  });
});
