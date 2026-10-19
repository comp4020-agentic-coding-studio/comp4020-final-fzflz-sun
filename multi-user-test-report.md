# Multi-user test report — Camp Clearer co-op

**App:** Camp Clearer (co-op expedition), `https://comp4020-final-fzflz-sun.fly.dev`
**Repo:** `final/comp4020-final-fzflz-sun`
**Commit verified:** `ec0fd8773de65edd8118f79a095b3311aa427d70` (clean worktree at verification time)
**Local test server:** `http://127.0.0.1:8080`, `DATA_DIR=.local/mu/data`, development mode
**Fly machine:** `d8d926dc9373e8` (`damp-paper-7229`, syd), volume `vol_4oj21dkkpxokwxqr`
**Test window:** 2026-10-19 ~05:00–05:21 UTC (~16:00–16:21 Australia/Sydney)
**Driver:** agent, at the author's request; WebSocket-level (no browser DOM), real HTTP/TCP/WS against the deployed app where noted.

## Result at a glance

| # | Step | Result |
|---|------|--------|
| 1 | System produces sufficient logs | **PASS** — 20/20 log checks; every required event type emitted |
| 2 | Deploy the version with logs | **PASS** — deployed revision equals HEAD; `check:deploy` passes |
| 3 | `mise exec -- flyctl logs -a <repo>` | **PASS** — 100 coop events captured from the running machine around a full scenario run |
| 4 | Users join | **PASS** — two distinct identities in one room, local and Fly |
| 5a | Two users join | **PASS** |
| 5b | One user's action reaches the other | **PASS** — movement and card play visible without reload |
| 5c | Simultaneous action within the same second | **PASS** — 1 ms apart, exactly one round resolved |
| 5d | **Late user join** | **PASS** — 13/13: late joiner gets the live room, both existing players see them, the in-progress fight is undisturbed |
| 5e | Leave and return | **PASS** — same identity, same fight, same hand; Fly graceful-close delay measured at ~5.06 s |
| 5f | Isolated room joins | **PASS** — separate rooms, separate membership, no cross-room movement |
| 5g | Scale machines until two users are on different machines | **FAIL (executed)** — two Fly machines each get their **own volume**; 11/20 room joins returned 404, and 4/10 two-socket attempts failed or saw the wrong machine. Restored to one machine / one volume afterwards |
| 5h | Restart machine mid-session | **PASS (Fly)** — 7/7: same fight, round and hand after `flyctl machine restart`; both players acted again |
| 6 | `multi-user-test-report.md` | This file |

**Bottom line:** with the correct app-scoped token, all six steps were executed on Fly. Multi-user behaviour, late join, isolation and restart all pass. Horizontal scaling **fails**, and the reason is structural: the app is a single-machine design (one volume, live room state in process memory). The Fly log pipeline is working and shows the expected events; it is not a reliable exact line-count ledger under bursts (one simultaneous `endTurn` line was missing from the captured Fly log while local capture had both).

---

## 1. Step 1 — sufficient logs

### What the server emits

The co-op server writes one JSON object per line to stdout (`server/log.ts`), which Fly's log pipeline captures. A local run of the full scenario set produced **297 log events across 26 rooms and 50 distinct actor ids**, covering:

| Event | Count | What it answers |
|---|---:|---|
| `coop.ws.connect` | 63 | who opened a socket (and rejected attempts, with reason) |
| `coop.ws.disconnect` | 56 | who left / dropped |
| `coop.room.create` | 25 | who created a room |
| `coop.room.join` | 31 | who joined which room, and refused joins |
| `coop.move.summary` | 37 | one line per movement spell, not per raw frame |
| `coop.encounter.formed` | 15 | which fight started, with its fixed roster |
| `coop.fight.card` | 11 | who played which card |
| `coop.fight.endTurn` | 11 | who readied, and the round boundary |
| `coop.fight.flee` | 26 | who fled (including the 30 s forced flee) |
| `coop.fight.ended` | 15 | fight outcome |
| `coop.room.peek` | 6 | who probed a code, and whether it existed |
| `coop.action.rejected` | 1 | refused actions, with a fixed reason code |

Properties that matter for the crit:

- Every line names the **actor id** (full SHA-256 of the co-op identity), and room/fight ids where relevant.
- Rejections are logged too, with a small reason code (`no_identity`, `not_a_member`, `no_such_room`, `not_in_fight`, …).
- No raw cookie, session token, or another player's card instance id appears in the output — checked by `pnpm check:log`.
- One movement spell is one line; the client can send many frames per second without flooding the log.

### The check

```sh
cd final/comp4020-final-fzflz-sun
mise exec -- pnpm check:log
```

Result: **20/20 checks passed**, including:

```
ok   server stdout contains at least one "coop.room.create" event
ok   server stdout contains at least one "coop.room.join" event
ok   server stdout contains at least one "coop.ws.connect" event
ok   server stdout contains at least one "coop.fight.card" event
ok   server stdout contains at least one "coop.action.rejected" event
ok   server stdout contains at least one "coop.fight.flee" event
ok   server stdout contains at least one "coop.ws.disconnect" event
ok   server stdout contains at least one "coop.fight.ended" event
ok   at least two distinct coop actor ids appear in the log (got 2)
ok   A's raw cookie token never appears in server stdout
ok   B's raw cookie token never appears in server stdout
ok   B's card instance id (the one A tried to steal) never appears in server stdout
```

Example lines from the local run (real output, timestamps UTC):

```json
{"event":"coop.room.create","ts":1792386365682,"identityNs":"coop","actorId":"d85aee...","actorName":"MU-mveskb1j-Ash","roomId":"THC4RH","result":"ok"}
{"event":"coop.room.join","ts":1792386365686,"identityNs":"coop","actorId":"2e001a...","actorName":"MU-mveskb1j-Birch","roomId":"THC4RH","result":"ok"}
{"event":"coop.ws.connect","ts":1792386365688,"identityNs":"coop","actorId":"d85aee...","actorName":"MU-mveskb1j-Ash","roomId":"THC4RH","connId":"1","result":"ok"}
{"event":"coop.fight.card","ts":1792386368771,"identityNs":"coop","actorId":"87f274...","roomId":"REJ53T","fightId":"f1","seq":1,"result":"ok","summary":{"cardName":"Cleave","cardKind":"aoe","targetKey":null}}
```

> The client-visible `actorId` is a SHA-256; two different browsers are two different ids even with the same display name. That is what makes the log usable for "who did what".

---

## 2. Step 2 — deployed version with logs

No new deploy was needed: the live app is already the tested commit.

```sh
mise exec -- pnpm check:deploy -- https://comp4020-final-fzflz-sun.fly.dev
```

```json
{
  "ok": true,
  "checkedAtUtc": "2026-10-19T05:05:12.027Z",
  "assetPaths": ["/assets/main-Df7y-l21.js", "/assets/world-DRg-Haz0.js"],
  "readmeImagePaths": ["/readme/docs/fight-desktop.png", "/readme/docs/fight-phone.png"],
  "readmeSha256": "9cb3dfb4505b77f2889298da50f6b314bdd0730cedb3fc39d2806125b4be88f1",
  "saveRoundTrip": true,
  "visitorIsolation": true,
  "testVisitorsErased": true,
  "sourceRevision": "ec0fd8773de65edd8118f79a095b3311aa427d70",
  "worktreeDirty": false
}
```

`sourceRevision` equals local `HEAD`, so the deployed app is the same code whose logging was verified in step 1. The deploy check also confirms the served README, assets, a save round trip, and separation between two visitors, and it erases only its own test visitors.

If a future change needs shipping, the command is:

```sh
mise exec -- flyctl deploy --remote-only --ha=false -a comp4020-final-fzflz-sun
```

---

## 3. Step 3 — `flyctl logs` — PASS

`flyctl` was pointed at `comp4020-final-fzflz-sun` with that app's deploy token, filtered to the running machine, while a full scenario run drove the app:

```sh
mise exec -- flyctl logs -a comp4020-final-fzflz-sun -m d8d926dc9373e8
```

The capture contained **144 lines / 100 co-op JSON events** in the window (some from the preceding minutes in Fly's buffer; the run's rooms are identifiable by the `MU-mvesxwnf` prefix) — create/join/connect/disconnect, movement, fight formation, card, endTurn and fight end. The late-join and restart captures add the `action.rejected` and post-restart `endTurn` lines used in §5d/§5h. A representative room (`ZDB5WM`) shows the full join → connect → action sequence:

```text
2026-10-19T05:16:40Z app[d8d926dc9373e8] syd [info]{"event":"coop.room.create","ts":1792387000282,"actorName":"MU-mvesxwnf-Ash","roomId":"ZDB5WM","result":"ok"}
2026-10-19T05:16:40Z app[d8d926dc9373e8] syd [info]{"event":"coop.room.join","ts":1792387000319,"actorName":"MU-mvesxwnf-Birch","roomId":"ZDB5WM","result":"ok"}
2026-10-19T05:16:40Z app[d8d926dc9373e8] syd [info]{"event":"coop.ws.connect","ts":1792387000407,"actorName":"MU-mvesxwnf-Ash","roomId":"ZDB5WM","connId":"1","result":"ok"}
2026-10-19T05:16:40Z app[d8d926dc9373e8] syd [info]{"event":"coop.ws.connect","ts":1792387000469,"actorName":"MU-mvesxwnf-Birch","roomId":"ZDB5WM","connId":"1","result":"ok"}
2026-10-19T05:16:46Z app[d8d926dc9373e8] syd [info]{"event":"coop.fight.endTurn","ts":1792387006664,"actorId":"639ff...","roomId":"47VJ69","fightId":"f1","seq":1,"result":"ok"}
```

A second capture during the late-join test and a third during the machine restart likewise carried the expected `coop.room.join`, `coop.ws.connect` and `coop.fight.endTurn` lines (see §5d and §5h).

**Log-capture caveat:** in the simultaneous-turn run the two `endTurn` messages were 1 ms apart and the client saw exactly one round resolve, but the captured Fly log contained only one of the two `endTurn` lines (local capture had both). Fly's log pipeline should not be treated as an exact multiplicity ledger under bursts; the client assertions and the local log are the evidence for "both were accepted, one round resolved".

---

## 4. Step 4/5 — scenarios

### Setup used

The deployed app was driven through its real REST + WebSocket API. Two independent identities were created by separate HTTP cookie jars (`cc_coop`), exactly as two Chrome profiles would be. Rooms are ephemeral; codes below are from the run and no longer meaningful.

The repo's own `tools/coop-live-check.mjs` was run against the deployed app as a consistency check:

```sh
mise exec -- node tools/coop-live-check.mjs https://comp4020-final-fzflz-sun.fly.dev
```

Result: **27/27 checks passed**, all five of its scenarios (two independent clients in one fight, reconnect/seq, individual flee, stale fight isolation, reconnect after a fight concluded while away).

### a) Two users join — PASS

- Room create returned a 6-character code and an identity cookie.
- A second HTTP identity joined with the code; both WebSockets opened.
- Both `hello` messages named the same room and both members; the two `selfId`s differed.
- The shared `state` showed two players, both online.

```json
{"event":"coop.room.create","ts":1792387000282,"actorName":"MU-mvesxwnf-Ash","roomId":"ZDB5WM","result":"ok"}
{"event":"coop.room.join","ts":1792387000319,"actorName":"MU-mvesxwnf-Birch","roomId":"ZDB5WM","result":"ok"}
{"event":"coop.ws.connect","ts":1792387000407,"actorName":"MU-mvesxwnf-Ash","roomId":"ZDB5WM","connId":"1","result":"ok"}
{"event":"coop.ws.connect","ts":1792387000469,"actorName":"MU-mvesxwnf-Birch","roomId":"ZDB5WM","connId":"1","result":"ok"}
```

### b) One user's action reaches the other — PASS

- A moved right; B's next `state` snapshots showed A's `x` change from `220.0` to `319.0` within the 150 ms room tick.
- Both walked into one fight; A played a real card; B's shared `fight` view showed the same fight, while B's own `hand` was unchanged.
- No reload was needed for either effect.

```json
{"event":"coop.fight.card","ts":1792386368771,"actorId":"87f274...","roomId":"REJ53T","fightId":"f1","seq":1,"result":"ok","summary":{"cardName":"Cleave","cardKind":"aoe","targetKey":null}}
```

### c) Simultaneous action within the same second — PASS

Both clients sent `endTurn` for the same fight in the same event-loop tick:

```text
c1 both endTurn messages were sent in the same second — 0 ms apart (local), 1 ms apart (Fly)
c2 the round advanced by exactly one, once — turn 1 -> 2/2
c3 neither simultaneous action was rejected
```

Local server log timestamps are **1 ms apart**, and only one round boundary is recorded:

```json
{"event":"coop.fight.endTurn","ts":1792386371498,"actorId":"a62362...","roomId":"V9U2MN","fightId":"f1","seq":1,"result":"ok"}
{"event":"coop.fight.endTurn","ts":1792386371499,"actorId":"4f7d02...","roomId":"V9U2MN","fightId":"f1","seq":1,"result":"ok"}
```

Scope note: this tests simultaneous **turn resolution**. Simultaneous **card plays** from both clients were not forced into the same millisecond; the card path is covered by the repo's live check (one player plays, the other's shared view and private hand are asserted).

### d) Late user join — PASS (13/13 on Fly)

Two players had already moved and started a fight (room `A3GS8T`, fight `f1`, turn 1, host at x≈607). Two seconds later a third identity joined with the code and connected:

```text
room A3GS8T: two players already in fight f1 at turn 1; host at (607, 398)
ok   d1  a late join with the room code succeeds — status 200
ok   d2  the join response already names all three members — 3 members
ok   d3  the late joiner gets a hello with the existing room and members — 3 members
ok   d4  the late joiner sees BOTH existing players immediately — 3 players in state
ok   d5  those players are at their live positions, not a fresh spawn — host x 607.4 -> 607.4
ok   d6  the late joiner also sees the existing fight's tag on the players — tags f1/f1
ok   d7  the two existing players see the late joiner arrive, online — 3 players in host state
ok   d8  the late joiner's own hello reports no fight membership — null
ok   d9  the late joiner receives no fight view and no private hand
ok   d10 the late joiner can explore and their movement reaches the existing players — x 220.0 -> 253.0
ok   d11 a fight action from the late joiner is refused: they are not in that fight — "you're not in a fight right now"
ok   d12 the existing fight is undisturbed by the late join — fight f1, turn 1 -> 1
ok   d13 the two original players can still resolve a round after the late join — turn 1 -> 2
```

Fly log for the same room:

```text
2026-10-19T05:17:33Z {"event":"coop.encounter.formed","roomId":"A3GS8T","fightId":"f1","result":"ok","summary":{"enemyKeys":"west-1", ...}}
2026-10-19T05:17:36Z {"event":"coop.room.join","actorName":"LJ-mvesz09e-Late","roomId":"A3GS8T","result":"ok"}
2026-10-19T05:17:36Z {"event":"coop.ws.connect","actorName":"LJ-mvesz09e-Late","roomId":"A3GS8T","connId":"1","result":"ok"}
2026-10-19T05:17:36Z {"event":"coop.action.rejected","actorId":"3eb2b2...","roomId":"A3GS8T","seq":1,"result":"rejected","reason":"not_in_fight"}
```

The late joiner is a full room member for the shared map and chat/state, but is **not** retroactively added to a fight whose roster was fixed at formation. That is the documented rule ("a fight's roster is the trigger, nearby chasers and their linked pack-mates… fixed once formation starts"), and it means a late joiner watches the fight tag but cannot act in it.

### Security boundary (supplementary, not one of the numbered scenarios)

While testing late join, the same room was also probed from outside:

| Attempt | Result |
|---|---|
| WebSocket with **no identity cookie** | refused (`no_identity`; local: socket hang up, Fly: HTTP 502 from the proxy) |
| Valid identity that **never joined** the room | refused (`not_a_member`, HTTP 404) |
| Join / peek a **guessed non-existent code** | 404 `no_such_room` |
| **Peek** an existing room unauthenticated | 200, `{ memberCount }` only — no names or identities |
| **Join** an existing room with the code | **succeeds by design** — the 6-character code is an invite capability |

This is ADR `docs/adr/0007-coop-identity-and-permissions.md`'s explicit choice: knowing the code is the invite, there are no accounts, and a room is not listed publicly. If the crit's requirement is "only an invited identity may join", the current app does **not** meet it — the code alone is enough. Flagging it as a decision to defend, not a bug.

### e) Leave and return — PASS, with a measured Fly timing caveat

- Same identity on return (`selfId` unchanged), same fight id, same `turn`, same hand cards and action `seq`.
- The other player saw the leaver go offline, then online again.
- Server log shows a disconnect and a reconnect by the **same actor id**:

```json
{"event":"coop.ws.disconnect","ts":1792386373817,"actorId":"e37a42...","roomId":"U47QBA","connId":"1","result":"ok"}
{"event":"coop.ws.connect","ts":1792386373921,"actorId":"e37a42...","roomId":"U47QBA","connId":"2","result":"ok"}
```

**Fly-specific finding:** a *graceful* WebSocket close took **5.06 s** to be observed as offline by the other player through the deployed Fly path; an abrupt `terminate()` took **204 ms**; locally both took ~204 ms. The first deployed run used a 5 s wait and missed it by 62 ms; a repeat with an 8 s wait passed. When narrating the crit, leave ~6 s after closing a tab, or close the tab rather than clicking a "leave" control, if the "offline" moment needs to be visible in a screenshot.

A player who disappears mid-fight and does not return within 30 s is resolved as a forced flee; the local log shows the `coop.fight.flee` line with `forced: true` at exactly +30 s. That is the documented reconnect window, not a bug, but it is a cost to mention.

### f) Isolated room joins — PASS

- Room A and room B had different codes.
- B's `hello` contained only B's two members; A never saw B's names in its `state`.
- B's owner moving produced a `coop.move.summary` on B only; A's state did not change.
- A cookie that is a member of B connecting to A was refused with `not_a_member`.

```json
{"event":"coop.room.create","ts":1792386374135,"actorId":"6ada15...","roomId":"TM8TMD","result":"ok"}
{"event":"coop.room.join","ts":1792386374137,"actorId":"3eda9e...","roomId":"TM8TMD","result":"ok"}
{"event":"coop.move.summary","ts":1792386374752,"actorId":"6ada15...","roomId":"TM8TMD","result":"ok","summary":{"durationMs":400,"lastDx":1,"lastDy":0}}
```

### g) Scale machines until two users are on different machines — FAIL (executed on Fly)

This step was run against Fly, not just modelled locally.

```sh
mise exec -- flyctl scale count 2 -a comp4020-final-fzflz-sun --yes
```

Fly created a **second machine** (`8ed99e5c347408`, `young-wind-936`) **and a new volume** (`vol_vjyl0m2m1532komv`) — it did not share the original volume. Both machines were started.

**20 create-then-join attempts** (each request on a fresh connection, so Fly's anycast could pick either machine):

```text
1 7N3382 join=200   2 XEPK57 join=200   3 HXU8S6 join=404
4 RDD76R join=404   5 GVXZ5H join=200   6 5Q45QH join=200
7 AECFVU join=200   8 XS3FUC join=404   9 Z3NX7P join=404
10 RARYTF join=404  11 Y5DX2Q join=200  12 PX4W2B join=404
13 7RTQB3 join=404  14 YUERJP join=200  15 NP4Y7U join=404
16 7N8KEW join=404  17 JCAA74 join=200  18 RAC767 join=404
19 NXJSXZ join=404  20 B3MS76 join=200
```

**11/20 joins returned 404** (`no_such_room`): the creator and the joiner landed on different machines with different volumes.

A 10-room WebSocket probe showed the same failure at the socket layer: **5 join failures, 4 socket failures, and only 1 room where both sockets were on the same machine**:

```text
{ "rooms": 10, "joinFailures": 5, "wsFailures": 4, "wsBothOk": 1 }
```

Per-machine logs show the cross-machine split explicitly:

```text
# room GAGQCG
machine 2 (8ed99e5c347408): coop.room.create ... ok
machine 2 (8ed99e5c347408): coop.room.join   ... ok
machine 1 (d8d926dc9373e8): coop.ws.connect ... rejected, reason=not_a_member   (both sockets)

# room G9N5SR
machine 2 (8ed99e5c347408): coop.room.create ... ok
machine 1 (d8d926dc9373e8): coop.room.join   ... rejected, reason=no_such_room

# room 7RQ8WX
machine 1: coop.room.create/join ... ok
machine 2: coop.ws.connect ... rejected, reason=not_a_member (host)
```

Restored afterwards:

```sh
mise exec -- flyctl scale count 1 -a comp4020-final-fzflz-sun --yes   # destroyed the second machine
mise exec -- flyctl volumes destroy vol_vjyl0m2m1532komv -a comp4020-final-fzflz-sun --yes
```

Final Fly shape confirmed: one machine `d8d926dc9373e8`, one volume `vol_4oj21dkkpxokwxqr`, `GET /` 200.

**Conclusion:** the co-op room is live in-memory state on one machine, backed by `/data`. Two Fly machines get separate volumes, so rooms do not exist on the second machine; even if a shared volume were possible (it is not, on Fly's volume model), the live sockets/room are per-process. This is a **single-machine design**; the "scale until two users are on different machines" scenario is a FAIL, not a pass. A correct horizontal design needs a shared real-time presence/pub-sub layer and a shared database, which is out of scope for this build.

The local two-process probe (run earlier) confirmed the same two shapes: separate data dirs → room 404; shared data dir → membership split (A sees 1, B sees 2) and movement not propagated.

### h) Fly machine restart mid-session — PASS (7/7 on Fly)

A real two-player fight was formed (room `CYXFS4`, fight `f1`, turn 1, both hands 4 cards / seq 0). With both players connected, the machine was restarted:

```sh
mise exec -- flyctl machine restart d8d926dc9373e8 -a comp4020-final-fzflz-sun
```

```text
Restarting machine d8d926dc9373e8
No health checks found
Machine d8d926dc9373e8 restarted successfully!
```

The app returned 200 about 6 s after the restart command. Both cookie identities reconnected and the driver checked:

```text
ok   h1 both identities reconnect to the restarted machine
ok   h2 the player identity is unchanged
ok   h3 the in-progress fight is still the same fight — f1
ok   h4 the round survived the restart — turn 1 -> 1
ok   h5 A's hand and seq survived exactly — cards 4 -> 4, seq 0 -> 0
ok   h6 B's hand and seq survived exactly — cards 4 -> 4, seq 0 -> 0
ok   h7 both players can act after the Fly restart and exactly one round resolves — turn 1 -> 2
```

Fly log around the restart (same room):

```text
05:19:55 {"event":"coop.ws.connect", ... "roomId":"CYXFS4","connId":"1"}
05:19:57 {"event":"coop.encounter.formed","roomId":"CYXFS4","fightId":"f1"}
05:20:13 {"event":"coop.ws.connect", ... "roomId":"CYXFS4","connId":"1"}   # after restart
05:20:15 {"event":"coop.ws.connect", ... "roomId":"CYXFS4","connId":"1"}
05:20:15 {"event":"coop.fight.endTurn", ... "fightId":"f1","seq":1,"result":"ok"}
05:20:15 {"event":"coop.fight.endTurn", ... "fightId":"f1","seq":1,"result":"ok"}  # 4 ms apart
05:20:15 {"event":"coop.ws.disconnect", ...}
```

There is no disconnect line for the sockets at the moment the machine was killed — the process disappeared; the reconnect lines after 05:20:13 are the evidence the restart happened. The local process-restart test (6/6) independently confirms the persistence/restore path.

---

## 5. Findings and risks

1. **Graceful disconnect visibility is slow through Fly.** 5.06 s vs 204 ms abrupt, while local is 204 ms. The app marks the player offline immediately on its own close event; the delay is on the Fly path. Demo implication: wait ~6 s, or close the tab, before claiming "they left".
2. **The room code is a capability, not authentication.** Anyone holding it can join and then appears in the room. No-identity and non-member sockets are refused; peek leaks only the member count. This is ADR 0007's decision; if the requirement is invite-only identity, this is a gap to state explicitly.
3. **Horizontal scaling is not supported.** Executed on Fly: two machines get separate volumes; 11/20 joins 404 and 4/10 socket attempts fail. One machine / one volume is the correct deployment shape. A shared real-time layer would be required.
4. **Restart is honest.** A `flyctl machine restart` mid-fight resumed the same fight, round and hands; both players could act immediately and one round resolved. This is the strongest reliability result in the run.
5. **No raw secrets in logs.** `check:log` proves no cookie, token, or other player's card instance id is written. Actor ids are full SHA-256 hashes, not display names alone.
6. **Forced flee after 30 s.** A player who closes the tab mid-fight is flee-costed after the reconnect window; the log records `forced: true`. Expected, but a visible cost.
7. **No-identity WebSocket through Fly returns 502** (locally: socket hang up). Both are rejections; a browser may show a generic connection error rather than the room's own message.
8. **Room codes are logged.** They are invite capabilities; anyone with log access can join a still-existing room. Rooms are ephemeral and no longer listed after the test, but this is worth knowing before sharing logs.
9. **Fly log capture is not an exact ledger.** One of two simultaneous `endTurn` lines was missing from the captured Fly log while local capture had both; use client assertions plus logs, not line counts alone.

## 6. What was not verified

- **A real browser two-person playtest** — the drivers are WebSocket-level, not browser DOM. The repo's `pnpm check:browser` / `tools/playtest.mjs` were not run; they cover a single browser, not two people.
- **Simultaneous card plays in the same millisecond** — only simultaneous `endTurn`; card propagation was tested sequentially.
- **Docker restart check** (`tools/coop-restart-check.sh`) — Docker daemon not running; the Fly machine restart covers the same state path more directly.
- **Sustained load / many rooms** — the 20-join and 10-room probes exercise cross-machine failure, not long-running throughput.

## 7. How to reproduce

Local:

```sh
cd final/comp4020-final-fzflz-sun
mise exec -- pnpm typecheck
mise exec -- pnpm test:unit                 # 441 tests, 17 files
APP_URL=http://127.0.0.1:8080 mise exec -- pnpm check   # 462 tests, 20 files, all pass
mise exec -- pnpm check:log                 # 20/20 log checks
mise exec -- pnpm dev                       # app + API on :8080
mise exec -- node tools/coop-live-check.mjs http://127.0.0.1:8080
mise exec -- node .local/mu/multi-user-test.mjs http://127.0.0.1:8080
mise exec -- node .local/mu/late-join-test.mjs http://127.0.0.1:8080
mise exec -- node .local/mu/restart-test.mjs
mise exec -- node .local/mu/multi-machine-test.mjs
```

Fly:

```sh
mise exec -- pnpm check:deploy -- https://comp4020-final-fzflz-sun.fly.dev
mise exec -- node tools/coop-live-check.mjs https://comp4020-final-fzflz-sun.fly.dev
mise exec -- node .local/mu/multi-user-test.mjs https://comp4020-final-fzflz-sun.fly.dev
mise exec -- node .local/mu/late-join-test.mjs https://comp4020-final-fzflz-sun.fly.dev
mise exec -- node .local/mu/disconnect-probe.mjs https://comp4020-final-fzflz-sun.fly.dev

mise exec -- flyctl logs -a comp4020-final-fzflz-sun -m d8d926dc9373e8
mise exec -- flyctl scale count 2 -a comp4020-final-fzflz-sun --yes
mise exec -- node .local/mu/two-machine-probe.mjs https://comp4020-final-fzflz-sun.fly.dev
mise exec -- flyctl scale count 1 -a comp4020-final-fzflz-sun --yes
mise exec -- flyctl volumes list -a comp4020-final-fzflz-sun
mise exec -- flyctl machine restart d8d926dc9373e8 -a comp4020-final-fzflz-sun
```

The `.local/mu/*.mjs` drivers are local evidence scripts (gitignored, not part of the shipped repo); the repo's own `coop-live-check` and `coop-log-check` are committed and cover the core protocol.

## 8. Evidence index (local, gitignored)

| File | Contents |
|---|---|
| `.local/mu/evidence/check-log.txt` | 20/20 log coverage checks, two actor ids, no secret/card leak |
| `.local/mu/evidence/check-deploy-deployed.txt` | deployed revision, assets, README, save round trip, visitor isolation |
| `.local/mu/evidence/coop-live-deployed.log` | repo live check against Fly: 27/27 |
| `.local/mu/evidence/multi-user-local.txt` / `.json` | 26/26 scenario checks, local |
| `.local/mu/evidence/multi-user-deployed.txt` / `.json` | 26/26 scenario checks, Fly |
| `.local/mu/evidence/late-join-deployed.txt` | 13/13 late-join checks on Fly |
| `.local/mu/evidence/restart-local.txt` | 6/6 local process restart checks |
| `.local/mu/evidence/fly-restart-test.txt` | 7/7 Fly machine-restart checks |
| `.local/mu/evidence/fly-logs-multiuser.log` | 100 coop events during the multi-user run |
| `.local/mu/evidence/fly-logs-latejoin.log` | 80 coop events during the late-join run |
| `.local/mu/evidence/fly-logs-restart.log` | 105 coop events around the machine restart |
| `.local/mu/evidence/fly-logs-machine-1.log` / `-2.log` | per-machine logs showing cross-machine 404s |
| `.local/mu/evidence/fly-scale-to-2.txt` | second machine + new volume created |
| `.local/mu/evidence/fly-scale-joins.txt` | 20 create/join attempts: 11 × 404 |
| `.local/mu/evidence/two-machine-probe.txt` | 10-room socket probe: 5 join / 4 socket failures |
| `.local/mu/evidence/fly-scale-to-1.txt` | restored to one machine; extra volume destroyed separately |
| `.local/mu/evidence/fly-machine-restart-cmd.txt` | `flyctl machine restart` result |
| `.local/mu/evidence/multi-machine-local.txt` | 6/6 local two-process architecture probe |
| `.local/mu/evidence/disconnect-probe-deployed.txt` | 5.06 s graceful / 204 ms abrupt offline visibility |
| `.local/mu/evidence/log-timeline.txt` | raw JSON log excerpt per room, plus restart log |
| `.local/mu/evidence/pnpm-check-local.txt` | full check against the local app: 462 tests, 20 files |
