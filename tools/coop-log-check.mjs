// Spawns a real server/index.ts process (the only way to prove its own
// business logging — not just CoopServer's, which already has unit-test
// seams — actually fires, since index.ts is a top-level script with no
// injectable sink), drives two real cookie-jar identities through a real
// sequence of create/join/connect/card-play/rejection/flee/disconnect/
// reconnect/fight-end, plus one real solo save write, then parses the
// captured stdout as JSON-lines and asserts: the expected event types all
// appear, with two distinct actor ids, and no raw cookie value or the
// other player's card content ever appears anywhere in the buffered output.
//
// Usage:
//   node tools/coop-log-check.mjs                 spawns its own server in a fresh temp dir
//   node tools/coop-log-check.mjs <baseUrl>        drives an already-running server instead
//                                                  (its own stdout isn't captured by this
//                                                  process in that mode — point it at a server
//                                                  whose own logs you can inspect separately,
//                                                  e.g. `docker logs`; CI uses the spawn mode)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
}

async function spawnServer() {
  const dataDir = mkdtempSync(join(tmpdir(), "cc-log-check-data-"));
  const port = 9100 + Math.floor(Math.random() * 400);
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  let raw = "";
  const onData = (chunk) => {
    raw += chunk.toString();
    let idx;
    while ((idx = raw.indexOf("\n")) >= 0) {
      lines.push(raw.slice(0, idx));
      raw = raw.slice(idx + 1);
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData); // vite/dev middleware warnings land here too; harmless noise for this check
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + "/");
      if (r.ok || r.status === 404) break;
    } catch {}
    await sleep(200);
  }
  return {
    base,
    lines,
    stop: () => {
      proc.kill();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function identityClient(base) {
  let cookie = "";
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, body: json };
  };
  return { api, cookie: () => cookie };
}

function connect(base, code, cookie) {
  const wsBase = base.replace(/^http/, "ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/coop/ws?code=${code}`, { headers: { cookie } });
    const msgs = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve({ ws, msgs, send: (m) => ws.send(JSON.stringify(m)) }));
    ws.on("error", reject);
  });
}
const last = (c, type) => [...c.msgs].reverse().find((m) => m.type === type);

async function walkIntoFight(a, b) {
  a.send({ type: "move", dx: 1, dy: -0.65 });
  b.send({ type: "move", dx: 1, dy: -0.65 });
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

async function main() {
  const baseArg = process.argv[2];
  const server = baseArg ? { base: baseArg, lines: null, stop: () => {} } : await spawnServer();
  console.log(server.lines ? `spawned server at ${server.base}` : `driving existing server at ${server.base}`);

  try {
    const a = await identityClient(server.base);
    const b = await identityClient(server.base);
    const created = await a.api("POST", "/api/coop/rooms", { name: "Log-Ash" });
    check(created.status === 200, "room created");
    const code = created.body.code;
    const joined = await b.api("POST", `/api/coop/rooms/${code}/join`, { name: "Log-Birch" });
    check(joined.status === 200, "room joined");

    const wsA = await connect(server.base, code, a.cookie());
    const wsB = await connect(server.base, code, b.cookie());
    await sleep(200);
    await walkIntoFight(wsA, wsB);

    const handB = last(wsB, "hand");
    const bCardId = handB.cards[0].id;

    // a real rejection: A tries to play B's card
    wsA.send({ type: "playCard", seq: 1, cardInstanceId: bCardId });
    await sleep(300);
    check(!!last(wsA, "actionError"), "the forged card play was rejected");

    // a real success: A plays one of her own cards. The 14-card deck always
    // has at least one affordable card (a resource card costs 0), so this
    // never needs a fallback to End Turn.
    const handA = last(wsA, "hand");
    const ownCard = handA.cards.find((c) => c.cost <= handA.energy && c.kind !== "single") ?? handA.cards.find((c) => c.cost <= handA.energy);
    check(!!ownCard, "A has at least one affordable card to play for real");
    wsA.send({ type: "playCard", seq: 1, cardInstanceId: ownCard.id, targetKey: ownCard.kind === "single" ? last(wsA, "fight").enemies[0].key : undefined });
    await sleep(300);

    // A flees; B alone finishes the fight by hitting the enemy until it's down,
    // so a real coop.fight.ended fires too, not just individual-flee traffic.
    wsA.send({ type: "flee", seq: 2 });
    await sleep(300);
    for (let i = 0; i < 20; i++) {
      const fb = last(wsB, "fight");
      if (!fb || fb.enemies.every((e) => e.downed)) break;
      const hb = last(wsB, "hand");
      if (!hb) break;
      const target = fb.enemies.find((e) => !e.downed);
      const singleCard = hb.cards.find((c) => c.kind === "single" && c.cost <= hb.energy);
      if (singleCard && target) {
        wsB.send({ type: "playCard", seq: hb.lastSeq + 1, cardInstanceId: singleCard.id, targetKey: target.key });
      } else {
        wsB.send({ type: "endTurn", seq: hb.lastSeq + 1 });
      }
      await sleep(250);
    }
    check(!!last(wsB, "fightEnded"), "B's fight actually concluded");

    // A disconnects, then reconnects
    wsA.ws.close();
    await sleep(300);
    const wsA2 = await connect(server.base, code, a.cookie());
    await sleep(200);
    check(!!last(wsA2, "hello"), "A reconnected and got a hello");
    wsA2.ws.close();
    wsB.ws.close();

    // a real solo save write, from a third, unrelated identity
    const solo = await identityClient(server.base);
    const cur = await solo.api("GET", "/api/save");
    const run = await solo.api("POST", "/api/runs", { baseRevision: cur.body.revision });
    check(run.status === 200, "solo run started");

    await sleep(300); // let the server's own stdout flush before reading it

    if (server.lines) {
      const jsonLines = server.lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);

      const eventTypes = new Set(jsonLines.map((e) => e.event));
      for (const expected of [
        "coop.room.create", "coop.room.join", "coop.ws.connect", "coop.fight.card",
        "coop.action.rejected", "coop.fight.flee", "coop.ws.disconnect", "coop.fight.ended",
        "save.run.start",
      ]) {
        check(eventTypes.has(expected), `server stdout contains at least one "${expected}" event`);
      }

      const actorIds = new Set(jsonLines.filter((e) => e.identityNs === "coop" && e.actorId).map((e) => e.actorId));
      check(actorIds.size >= 2, `at least two distinct coop actor ids appear in the log (got ${actorIds.size})`);

      const rawOutput = server.lines.join("\n");
      check(!rawOutput.includes(a.cookie().split("=")[1] ?? "\0impossible"), "A's raw cookie token never appears in server stdout");
      check(!rawOutput.includes(b.cookie().split("=")[1] ?? "\0impossible"), "B's raw cookie token never appears in server stdout");
      check(!rawOutput.includes(bCardId), "B's card instance id (the one A tried to steal) never appears in server stdout");
    } else {
      console.log("  (no spawned-process stdout to check — a baseUrl was given; verify its own logs separately, e.g. docker logs)");
    }
  } finally {
    server.stop();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
