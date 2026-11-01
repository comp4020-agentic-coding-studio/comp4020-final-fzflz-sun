// Real headless-Chrome check of co-op under slow networks: two separate
// Chrome profiles (separate user-data-dirs, so separate cookies/identities)
// play one room over a throttled link. Measures, rather than assumes:
//   - movement propagation each way: time from one page's key press to the
//     first `state` WebSocket frame the OTHER page receives showing that
//     player moved (frame arrival is after throttling, so it is what the
//     player would actually wait for)
//   - a shared fight: walk in, one card, one end turn per player; the round
//     must advance by exactly one and no action may be lost or duplicated
//   - going offline: the network goes offline and the socket drops, then the
//     network returns; the client must reconnect as the same identity and
//     resume the same fight with its hand intact
//   - any uncaught page error
//
// How the link is throttled matters. CDP's Network.emulateNetworkConditions
// delays HTTP but, measured directly, does NOT delay WebSocket messages
// (a move-to-own-state round trip stayed ~120-150 ms at 0, 400 and 1500 ms
// emulated latency), and every real-time co-op action is a WebSocket
// message. So each browser reaches the server through a local TCP proxy that
// delays every chunk by the profile's one-way latency in each direction and
// paces it to the profile's bandwidth: HTTP and WebSocket traffic both pay
// it, as on a real slow link. CDP throttling is not used on top, so the
// latency is not counted twice. Offline is simulated by the proxy refusing
// new connections and cutting live ones.
//
// Thresholds are generous on purpose: the question is "still usable", not a
// strict 1 s budget on a 400 ms-RTT link.
//
// Only disposable local rooms are created. Results are printed and written to
// .local/checks/slow-network/results.json.
//
// Usage: node tools/coop-slow-network-check.mjs [baseUrl]   (default http://127.0.0.1:8080)
import { spawn } from "node:child_process";
import { createServer, connect as tcpConnect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:8080";
const OUT = process.env.SHOTS ?? ".local/checks/slow-network";
const CHROME = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
].filter(Boolean).find(existsSync);
if (!CHROME) throw new Error("Chrome not found (set CHROME)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Throughput is bytes/second in CDP. These match Chrome DevTools' own presets.
const PROFILES = [
  { name: "Fast 3G", latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  { name: "Slow 3G", latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 },
];
// "still usable" budgets, deliberately loose; a 400 ms one-way latency on both
// pages puts a cross-player round trip near 1.6 s before any server tick.
const BUDGET = { "Fast 3G": { move: 2500, fight: 4000, reconnect: 20000 }, "Slow 3G": { move: 5000, fight: 8000, reconnect: 30000 } };

/**
 * A local TCP proxy in front of the real server that behaves like a slow
 * link: every chunk waits `latency` ms one way, and each direction is paced
 * to its bandwidth (bytes/s), in order. `offline()` refuses new connections
 * and cuts live ones, which is what the browser sees when the network drops.
 */
function slowLink(target, profile) {
  const { hostname, port } = new URL(target);
  let isOffline = false;
  const live = new Set();
  // one direction of one connection: FIFO, each chunk delivered at
  // max(arrival + latency, previous delivery + transmit time)
  const pipe = (src, dst, bytesPerSec) => {
    let nextFree = 0;
    src.on("data", (chunk) => {
      const now = Date.now();
      const transmit = bytesPerSec > 0 ? (chunk.length / bytesPerSec) * 1000 : 0;
      nextFree = Math.max(now + profile.latency, nextFree) + transmit;
      const due = nextFree - now;
      setTimeout(() => {
        if (!dst.destroyed) dst.write(chunk);
      }, due);
    });
    src.on("end", () => setTimeout(() => dst.end(), Math.max(0, nextFree - Date.now())));
  };
  const server = createServer((client) => {
    if (isOffline) return client.destroy();
    const upstream = tcpConnect(Number(port || 80), hostname);
    live.add(client);
    live.add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      live.delete(client);
      live.delete(upstream);
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", drop);
    upstream.on("close", drop);
    pipe(client, upstream, profile.uploadThroughput);
    pipe(upstream, client, profile.downloadThroughput);
  });
  return {
    listen: () => new Promise((res) => server.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${server.address().port}`))),
    offline: () => {
      isOffline = true;
      for (const s of live) s.destroy();
      live.clear();
    },
    online: () => {
      isOffline = false;
    },
    close: () => {
      for (const s of live) s.destroy();
      server.close();
    },
  };
}

let failures = 0;
const results = [];
function check(cond, msg) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
  return cond;
}

async function openTab(label, base) {
  const profile = mkdtempSync(join(tmpdir(), `cc-slow-${label}-`));
  const chrome = spawn(CHROME, ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--headless", "--no-sandbox", "--window-size=1100,750", "about:blank"], { stdio: "ignore" });
  let ws;
  const deadline = Date.now() + 15000;
  while (!ws && Date.now() < deadline) {
    try {
      const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener("open", res, { once: true });
          ws.addEventListener("error", rej, { once: true });
        });
      }
    } catch {}
    if (!ws) await sleep(150);
  }
  if (!ws) throw new Error(`[${label}] could not connect to Chrome`);
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  // Test-only, injected by this check (no app code change): wrap the page's
  // WebSocket to record every co-op message with the time this page received
  // it, after the slow link. CDP's own Network.webSocketFrameReceived did not
  // report these sockets in headless Chrome here, so frames are recorded in
  // the page instead; the timestamps are this page's own Date.now().
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const W = window.WebSocket;
      window.__slowNetFrames = [];
      function Wrapped(...a) {
        const s = new W(...a);
        s.addEventListener("message", (e) => { try { window.__slowNetFrames.push({ t: Date.now(), msg: JSON.parse(e.data) }); } catch {} });
        return s;
      }
      Wrapped.prototype = W.prototype;
      Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      window.WebSocket = Wrapped;
    })();`,
  });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  /** every co-op server message this page received, with its arrival time (page clock, ms), pulled fresh on each call */
  let frames = [];
  const pullFrames = async () => {
    const v = await evaluate("JSON.stringify(window.__slowNetFrames ?? [])").catch(() => null);
    if (v) frames = JSON.parse(v);
    return frames;
  };
  return {
    label, pageErrors, evaluate, pullFrames,
    get frames() { return frames; },
    navigate: async (path) => {
      await send("Page.navigate", { url: base + path });
      await sleep(800);
    },
    key: (key, code, type) => send("Input.dispatchKeyEvent", { type, key, code }),
    state: async () => {
      const s = await evaluate("JSON.stringify(window.__coop?.())");
      return s ? JSON.parse(s) : null;
    },
    close: () => {
      try {
        chrome.kill();
      } catch {}
    },
  };
}

const lastFrame = (tab, type) => [...tab.frames].reverse().find((f) => f.msg.type === type)?.msg;
const framesOf = (tab, type, since = 0) => tab.frames.filter((f) => f.msg.type === type && f.t >= since);

const openTabs = [];
const refresh = () => Promise.all(openTabs.map((t) => t.pullFrames()));

/** Polls `fn` every 50 ms (refreshing every tab's recorded frames first) until it returns a truthy value or `ms` passes. */
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await refresh();
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

/**
 * Movement latency: from the key press on `actor` until `observer` has
 * received a state frame showing `actorId` at least 40 px past where the
 * observer last saw it before the press. 40 px (about 180 ms of movement at
 * 220 px/s) rules out reconciliation drift being read as a response. Both
 * timestamps are this machine's Date.now(): Node for the press, the page for
 * the frame arrival, so the comparison is on one clock.
 */
async function measureMove(actor, observer, actorId, key, code, axis, sign) {
  await refresh();
  const baseline = lastFrame(observer, "state")?.players.find((p) => p.id === actorId)?.[axis];
  if (baseline === undefined) return null;
  const t0 = Date.now();
  await actor.key(key, code, "keyDown");
  const seen = await waitFor(() => {
    for (const f of framesOf(observer, "state", t0)) {
      const p = f.msg.players.find((q) => q.id === actorId);
      if (p && sign * (p[axis] - baseline) >= 40) return f.t;
    }
    return null;
  }, 15000);
  await sleep(400);
  await actor.key(key, code, "keyUp");
  return seen ? seen - t0 : null;
}

const KEY_CODES = { w: "KeyW", a: "KeyA", s: "KeyS", d: "KeyD" };
/**
 * Walks `tab`'s player toward west-1 until the server puts them in a fight.
 * Steers from the SERVER's position for this player (from the last state frame
 * the page received) toward west-1's CURRENT position, not a fixed point and
 * not the client's own predicted position. On a 400 ms one-way link the
 * prediction runs ~60 px ahead of the authoritative position, so steering by
 * prediction stopped short of engage range while west-1 kept moving (seen in
 * 2 of 6 Slow 3G runs). A real player walks at the enemy they can see.
 */
async function steer(tab, selfId, held, maxIters = 120) {
  for (let i = 0; i < maxIters; i++) {
    const g = await tab.state();
    if (g?.fight) return true;
    await tab.pullFrames();
    const st = lastFrame(tab, "state");
    const me = st?.players.find((p) => p.id === selfId);
    const target = st?.enemies.find((e) => e.id === "west-1") ?? { x: 640, y: 380 };
    if (me) {
      const want = new Set();
      if (Math.abs(target.x - me.x) > 6) want.add(target.x > me.x ? "d" : "a");
      if (Math.abs(target.y - me.y) > 6) want.add(target.y > me.y ? "s" : "w");
      for (const k of Object.keys(KEY_CODES)) {
        if (want.has(k) && !held.has(k)) {
          await tab.key(k, KEY_CODES[k], "keyDown");
          held.add(k);
        } else if (!want.has(k) && held.has(k)) {
          await tab.key(k, KEY_CODES[k], "keyUp");
          held.delete(k);
        }
      }
    }
    await sleep(200);
  }
  return false;
}
async function releaseAll(tab, held) {
  for (const k of [...held]) await tab.key(k, KEY_CODES[k], "keyUp");
  held.clear();
}

async function runProfile(profile) {
  console.log(`\n# ${profile.name}: latency ${profile.latency} ms, down ${Math.round((profile.downloadThroughput * 8) / 1024)} kbps, up ${Math.round((profile.uploadThroughput * 8) / 1024)} kbps (both pages)`);
  const budget = BUDGET[profile.name];
  const r = { profile: profile.name, latencyMs: profile.latency, downKbps: Math.round((profile.downloadThroughput * 8) / 1024), upKbps: Math.round((profile.uploadThroughput * 8) / 1024) };
  // one slow link per player, so one can go offline while the other stays up
  const linkA = slowLink(BASE, profile);
  const linkB = slowLink(BASE, profile);
  const a = await openTab("a", await linkA.listen());
  const b = await openTab("b", await linkB.listen());
  openTabs.length = 0;
  openTabs.push(a, b);
  try {
    // both pages load, join and play entirely through their slow link
    let t = Date.now();
    await a.navigate("/coop.html");
    check(!!(await waitFor(() => a.evaluate("typeof document.getElementById('createBtn')?.onclick === 'function'"), 30000)), `A's page finishes loading its script (${Date.now() - t} ms)`);
    await a.evaluate(`document.getElementById('nameInput').value='Slow-A'; document.getElementById('createBtn').click()`);
    const aHello = await waitFor(async () => (await a.state())?.selfId && lastFrame(a, "hello"), 20000);
    r.createAndConnectMs = aHello ? Date.now() - t : null;
    check(!!aHello, `A loads the page, creates a room and connects (${r.createAndConnectMs} ms)`);
    const code = await a.evaluate(`document.getElementById('roomCodeText').textContent`);
    t = Date.now();
    await b.navigate(`/coop.html?code=${code}`);
    check(!!(await waitFor(() => b.evaluate("typeof document.getElementById('joinBtn')?.onclick === 'function'"), 30000)), `B's page finishes loading its script (${Date.now() - t} ms)`);
    await b.evaluate(`document.getElementById('nameInput').value='Slow-B'; document.getElementById('joinBtn').click()`);
    const bHello = await waitFor(async () => (await b.state())?.selfId && lastFrame(b, "hello"), 20000);
    r.joinAndConnectMs = bHello ? Date.now() - t : null;
    check(!!bHello, `B opens the invite link, joins and connects (${r.joinAndConnectMs} ms)`);
    const aId = aHello.selfId;
    const bId = bHello.selfId;
    check(aId && bId && aId !== bId, "two distinct identities");
    await sleep(1000);

    // movement both ways, measured at the OTHER page's received frame
    await refresh();
    r.moveAtoBMs = await measureMove(a, b, aId, "s", "KeyS", "y", 1);
    check(r.moveAtoBMs !== null && r.moveAtoBMs <= budget.move, `A's movement reaches B in ${r.moveAtoBMs} ms (usable budget ${budget.move} ms)`);
    await sleep(800);
    await refresh();
    r.moveBtoAMs = await measureMove(b, a, bId, "s", "KeyS", "y", 1);
    check(r.moveBtoAMs !== null && r.moveBtoAMs <= budget.move, `B's movement reaches A in ${r.moveBtoAMs} ms (usable budget ${budget.move} ms)`);

    // shared fight: steer both to west-1's spawn (src/world.ts)
    const ha = new Set();
    const hb = new Set();
    t = Date.now();
    const [inA, inB] = await Promise.all([steer(a, aId, ha), steer(b, bId, hb)]);
    await releaseAll(a, ha);
    await releaseAll(b, hb);
    const fa = (await a.state())?.fight;
    const fb = (await b.state())?.fight;
    const shared = check(inA && inB && fa && fb && fa.fightId === fb.fightId, `both reach the same fight (${Date.now() - t} ms of walking)`);
    if (!shared) throw new Error("no shared fight; skipping fight and reconnect steps");
    await sleep(800);

    // A plays one non-lethal-if-possible card; measure until B's fight view changes (west-1 has 6 HP)
    const hand = (await a.state()).hand;
    const enemyKey = fa.enemies[0].key;
    const card = hand.cards.find((c) => c.kind === "guard" && c.cost <= hand.energy) ?? hand.cards.find((c) => c.kind === "resource") ?? hand.cards.find((c) => c.cost <= hand.energy);
    await refresh();
    const aHandsBefore = framesOf(a, "hand").length;
    t = Date.now();
    await a.evaluate(`(() => {
      const target = [...document.querySelectorAll('#enemyList button')][0]; target?.click();
      const btn = [...document.querySelectorAll('#hand button')].find(x => x.querySelector('.name')?.textContent === ${JSON.stringify(card.name)} && !x.disabled);
      btn?.click();
    })()`);
    // B must see the card's actual effect, A's block in B's own fight view, not
    // merely a frame that was already on its way before the click. Only Guard has
    // an effect B can see without ambiguity, so the latency is only claimed for it.
    const aBlockBefore = lastFrame(b, "fight")?.players.find((p) => p.id === aId)?.block ?? 0;
    const bSawCard = card.kind !== "guard" ? null : await waitFor(() => {
      for (const f of framesOf(b, "fight", t)) {
        const ap = f.msg.players.find((p) => p.id === aId);
        if (ap && ap.block > aBlockBefore) return f.t;
      }
      return null;
    }, budget.fight * 2);
    r.cardToOtherMs = bSawCard ? bSawCard - t : null;
    const aHandAfter = await waitFor(() => framesOf(a, "hand").length > aHandsBefore && framesOf(a, "hand").at(-1).msg, budget.fight * 2);
    if (card.kind === "guard") check(r.cardToOtherMs !== null && r.cardToOtherMs <= budget.fight, `A's Guard shows as A's block in B's fight view after ${r.cardToOtherMs} ms (usable budget ${budget.fight} ms)`);
    else console.log(`  (A's hand had no Guard; played ${card.name}; card-to-other latency not measured this run)`);
    const expectedEnergy = hand.energy - card.cost + (card.kind === "resource" ? 1 : 0);
    check(aHandAfter && aHandAfter.energy === expectedEnergy, `A's card applied exactly once (energy ${hand.energy} -> ${aHandAfter?.energy}, expected ${expectedEnergy})`);
    await refresh();
    const fightEndedEarly = !!lastFrame(a, "fightEnded");

    // both end turn: the round must advance by exactly one, once
    if (!fightEndedEarly) {
    await refresh();
      const turnBefore = lastFrame(a, "fight").turn;
      t = Date.now();
      await a.evaluate(`document.getElementById('endTurnBtn')?.click()`);
      await sleep(150);
      await b.evaluate(`document.getElementById('endTurnBtn')?.click()`);
      const advanced = await waitFor(() => {
        const fa2 = lastFrame(a, "fight");
        const fb2 = lastFrame(b, "fight");
        return fa2?.turn > turnBefore && fb2?.turn > turnBefore ? Date.now() : null;
      }, budget.fight * 2);
      r.roundResolveMs = advanced ? advanced - t : null;
      await sleep(1500); // let any duplicate resolution arrive, if there were one
    await refresh();
      const turnsA = framesOf(a, "fight").map((f) => f.msg.turn);
      check(r.roundResolveMs !== null && r.roundResolveMs <= budget.fight, `both end turn; the round resolves for both in ${r.roundResolveMs} ms (usable budget ${budget.fight} ms)`);
      check(Math.max(...turnsA) === turnBefore + 1, `the round advanced exactly once (turn ${turnBefore} -> ${Math.max(...turnsA)})`);
      const errs = [...framesOf(a, "actionError"), ...framesOf(b, "actionError")].map((f) => f.msg.error);
      check(errs.length === 0, `no action was rejected as stale or duplicate (${errs.join(" | ") || "none"})`);
    } else {
      console.log("  (A's card ended the fight; end-turn step skipped)");
    }

    // offline -> reconnect, mid-fight: A's slow link cuts its live connections
    // and refuses new ones for 4 s, so the client's first reconnect attempts
    // genuinely fail, then the link comes back. B's link is untouched.
    await refresh();
    if (!lastFrame(a, "fightEnded")) {
      const fightIdBefore = lastFrame(a, "fight").fightId;
      const handBefore = lastFrame(a, "hand");
      const hellosBefore = framesOf(a, "hello").length;
      linkA.offline(); // A's network drops: live connections cut, new ones refused
      await sleep(4000);
      const statusOffline = (await a.state())?.status ?? "";
      r.offlineStatus = statusOffline;
      check(/disconnected|reconnecting|connection error|connecting/i.test(statusOffline), `while offline, A's page says so instead of looking connected ("${statusOffline}")`);
      t = Date.now();
      linkA.online();
      const reHello = await waitFor(() => framesOf(a, "hello").length > hellosBefore && framesOf(a, "hello").at(-1), budget.reconnect);
      r.reconnectMs = reHello ? Date.now() - t : null;
      check(!!reHello, `A reconnects after the network returns, in ${r.reconnectMs} ms (budget ${budget.reconnect} ms, includes client backoff)`);
      if (reHello) {
        check(reHello.msg.selfId === aId, "same identity after reconnecting");
        check(reHello.msg.fightId === fightIdBefore, `back in the same fight (${reHello.msg.fightId})`);
        const handAfter = await waitFor(() => framesOf(a, "hand", reHello.t).at(-1)?.msg, 5000);
        check(
          handAfter && JSON.stringify(handAfter.cards.map((c) => c.id)) === JSON.stringify(handBefore.cards.map((c) => c.id)) && handAfter.lastSeq === handBefore.lastSeq,
          `hand and action counter survive the drop (seq ${handBefore.lastSeq} -> ${handAfter?.lastSeq})`,
        );
      }
    }

    r.pageErrors = [...a.pageErrors, ...b.pageErrors];
    check(r.pageErrors.length === 0, `no uncaught page errors (${r.pageErrors.slice(0, 2).join(" | ")})`);
  } catch (e) {
    r.error = String(e.message ?? e);
    console.log(`  FAIL ${r.error}`);
    failures++;
  } finally {
    a.close();
    b.close();
    linkA.close();
    linkB.close();
  }
  results.push(r);
}

for (const p of (process.env.ONLY ? PROFILES.filter((x) => x.name === process.env.ONLY) : PROFILES)) await runProfile(p);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2) + "\n");
console.log(`\n${JSON.stringify(results, null, 2)}`);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall slow-network checks passed");
process.exit(failures ? 1 : 0);
