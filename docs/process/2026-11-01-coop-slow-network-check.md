# Stage card: co-op on a slow connection

Title / date: repeatable slow-network check, 1 November 2026
Status: check added and run locally against the production build; no app bug
found, no app behaviour changed
Starting commit: `e88419e`

## Why

The final project's top band asks the app to hold up under use it wasn't
designed for, including a slow connection. `multi-user-test-report.md` drove
two real identities against the deployed app but never throttled the network.

## What the check does

`tools/coop-slow-network-check.mjs` (`pnpm check:slow <baseUrl>`) opens two
headless Chrome instances with separate profiles (separate cookies, so two
identities), creates a room in one and joins it from the other through the
invite link, then for each network profile:

- measures movement each way: from one player's key press to the first
  `state` message the *other* page receives showing that player at least
  40 px from where it last saw them;
- walks both into one fight with west-1, has A play a card and both end the
  turn, and checks the round advances exactly once with no action rejected;
- cuts A's network for 4 s mid-fight, restores it, and checks A reconnects as
  the same identity, in the same fight, with the same hand and action counter;
- records any uncaught page error.

Timestamps are this machine's `Date.now()` (Node for the key press, the page
for message arrival), so they share one clock. Budgets are "still usable", not
1 s: 2.5 s / 4 s / 20 s for movement / fight / reconnect on Fast 3G, and 5 s /
8 s / 30 s on Slow 3G.

## Network settings

Each player reaches the server through its own local TCP proxy started by the
check. Every chunk is delayed by the one-way latency in each direction, so a
round trip pays it twice, and each direction is paced to its bandwidth in
order. Offline means the proxy cuts live connections and refuses new ones.

| Profile | One-way latency | Down | Up |
| --- | --- | --- | --- |
| Fast 3G | 150 ms | 1638 kbps | 750 kbps |
| Slow 3G | 400 ms | 400 kbps | 400 kbps |

These are Chrome DevTools' own preset values.

## Results

Three full runs (both profiles each), 1 November 2026, against a local
production build (`pnpm build`, `NODE_ENV=production`) of `e88419e` plus
this check. All checks passed in all three; no uncaught page errors.

| Measurement | Fast 3G (ms) | Slow 3G (ms) |
| --- | --- | --- |
| A: page load, create room, connect | 2437, 2438, 2437 | 7614, 7594, 7605 |
| B: open invite link, join, connect | 2410, 2414, 2409 | 7592, 7590, 7592 |
| A moves, B sees it | 531, 545, 612 | 1035, 1118, 1024 |
| B moves, A sees it | 553, 566, 577 | 1048, 1026, 1044 |
| A plays Guard, B sees A's block | 315, 306, 306 | 826, 845, not measured* |
| Both end turn, round resolves for both | 490, 488, 488 | 1003, 1044, 1040 |
| A's network back, A reconnected | 3358, 3356, 3330 | 3897, 3856, 3888 |

\* A drew no Guard that run and played Focus; only Guard has an effect B can
see without ambiguity, so the check does not claim a latency for other cards.

Separately, the Slow 3G walk into a shared fight succeeded 6 of 6 times
(6.4–9.6 s of walking) after the steering correction below.

Every run: the card applied exactly once, the round advanced by exactly one,
no action was rejected as stale or duplicate, and while offline the page said
"disconnected — reconnecting…" rather than looking connected. Reconnect time
is dominated by the client's own backoff (the third attempt lands about 4 s
after the drop), not by the link.

The latencies match the physics: one cross-player action costs two one-way
hops (2 × 150 ms or 2 × 400 ms) plus up to one 150 ms server tick, and
movement adds the time to travel 40 px.

## Correction record

| Observed problem | Fix / check | Result |
| --- | --- | --- |
| Against `pnpm dev`, the page stayed "connecting…" after 25 s even on Fast 3G | Not an app bug: Vite's dev server loads unbundled modules and its own HMR socket. The check targets the production build, which is what players get | Production build connects in about 2.4 s on Fast 3G |
| Clicking Create right after navigation did nothing under throttling | The click landed before the module script attached its handler; the check now waits for the join form to be wired up | Both pages join reliably |
| CDP's `Network.emulateNetworkConditions` was the first throttle tried; measured movement was 241 ms on "Slow 3G" | Measured directly: it delays HTTP (fetch 4 → 406 → 1507 ms) but not WebSocket messages (~120–150 ms at 0, 400 and 1500 ms). Replaced with a per-player delaying TCP proxy | Movement now about 540 ms / 1050 ms, scaling with latency |
| Early latencies were optimistic (a Guard "reached" B in 5 ms) | A message already in flight was counted as the response. The check now matches content: A's block in B's own view, and a 40 px move from a fresh baseline | Numbers above |
| Slow 3G shared fight formed 4 of 6 times | Diagnostics showed both enemies chasing but players stopping about 100 px short: steering used the client's predicted position, about 60 px ahead of the server's on a 400 ms link. Now steers from the server's position toward west-1's current position | 6 of 6 |

## Limits

- Local loopback with simulated latency and bandwidth, not a real mobile
  network: no packet loss, jitter or reordering.
- Run against the production build locally, not against the deployed app. The
  proxy could front the deployed URL, but that would add real internet latency
  of unknown size on top of the profile.
- Not wired into CI: it takes about two minutes and is a measurement as much
  as a pass/fail. Run it with `pnpm check:slow <baseUrl>` against a
  production build.
- Two players only. No human has played on a slow connection; this shows the
  mechanism holds up, not how it feels.
