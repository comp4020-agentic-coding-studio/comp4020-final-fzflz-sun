# ADR 0007: Anonymous per-browser identity stays; the room code is the invite, not a login

Status: accepted, 2026-10-17 (crit 10)

## Context

Crit 10 asks for two things this project hadn't previously had to state
explicitly: a documented identity model answering "how does the server
tell two people apart," and a documented, server-enforced permission
boundary answering "what can each of them see and change" — a client-only
restriction fails the brief outright. It also requires durable,
server-side logging of who did what, surviving past the crit session.

A source review of `server/coop/ws.ts`, `server/index.ts`,
`server/coop/room.ts` and `server/coop/fight-session.ts` found the
identity and authorization mechanics already correct, inherited from ADR
0002 (anonymous visitors) and ADR 0005 (co-op multiplayer) — this ADR
documents and ratifies those existing decisions rather than changing them,
and records the two real gaps the review found: one endpoint over-shared
room membership to an unauthenticated prober, and no logging of any kind
existed to make any of this observable after the fact.

## Decision

- **Who:** identity stays anonymous and per-browser, with two already-
  separate namespaces kept separate: `cc_visitor` (`server/index.ts`'s
  `visitorFor()`) for single-player saves, `cc_coop` (`server/coop/ws.ts`'s
  `identityFor()`) for co-op rooms. Both are a random 256-bit HttpOnly
  cookie, stored server-side only as its SHA-256 hash — no account, no
  password, no OAuth. A display name is never identity: two players named
  "Ash" in the same room are two different actors, distinguished only by
  their server-derived id. No request ever carries a client-suppliable
  identity field (no `playerId`/`ownerId` in any body or message) that the
  server reads as "who is acting" — identity always comes from the
  connection the server itself resolved from the cookie.
- **What a room code is:** a 6-character code is an invite *capability*,
  not a login and not a public listing. Knowing it is deliberately
  sufficient to join (that's the whole point of "share a link, they're
  in") — but knowing it must not be sufficient to see who's already there
  without joining. `GET /api/coop/rooms/:code` ("peek," used by the join
  form to confirm a code is live before submitting) now returns only
  `{code, memberCount}` — no ids, names, or colors — closing an over-share
  the review found (the endpoint previously returned the full member
  list to anyone who merely guessed or obtained the code, unauthenticated,
  and was confirmed unused by the client beyond existence-checking).
- **Permission boundary**, enforced server-side at the points listed:

  | Actor can... | Server enforcement point | Rationale |
  | --- | --- | --- |
  | Create a room, get assigned its first color/identity | `identityFor()` resolves the actor before `handleApi`'s create branch does anything (`server/coop/ws.ts`) | identity exists before any room object does |
  | Join a room given its code | `handleApi`'s join branch; 404 if the code doesn't exist, otherwise any identity may join | the code itself is the invite — this is intentional, not a gap |
  | See a room's existence/size before joining | the peek endpoint, shrunk to `{code, memberCount}` | enough to validate a code without leaking who's inside |
  | Open that room's live WebSocket | `attach()`'s upgrade handler: rejects with a bare 404-and-destroy unless `room.players.get(playerId)` already exists for that identity (lines ~292-296) | a valid identity who never joined this specific room cannot connect to it at all |
  | Move their own character | `room.setIntent(playerId, ...)`, where `playerId` is the server-resolved connection identity, never a message field | movement can only ever be attributed to whoever is actually connected |
  | Act in a fight (play a card, end turn, flee) | `handleFightAction` resolves `fightId` from `room.players.get(playerId)`, then `FightSession.applyAction(playerId, ...)` — `playerId` is always the server-resolved identity | an action can never be submitted "as" another player; there is no field to forge |
  | Play a specific card | `applyAction`'s `ps.handIds.indexOf(action.cardInstanceId)`, scoped to `playerStates.get(playerId)` — i.e. *this* player's own hand only | a card instance id naming another player's card simply fails lookup; it can never resolve to their card |
  | See their own hand and private action state | `sendTo(room, playerId, ...)` filters every send by the resolved identity (`server/coop/ws.ts`) | private views are never broadcast; only `fightView`/`broadcastState` (public position, public fight state) go to every member |
  | See other members' position, name, color, online status, and public fight state | `broadcastState`/`fightView`, sent to every connected member of the room/fight | this is the "shared world" itself — position and public combat state are the point of co-op |
  | Delete/overwrite their own single-player save | every `server/index.ts` save-API call is scoped to `visitorFor(req, res)`'s resolved id; no request body field can name a different visitor | identical pattern to the co-op side, one visitor namespace earlier (ADR 0002) |

- **Logging:** a shared, JSON-lines-to-stdout logger (`server/log.ts`)
  records who-did-what for both the solo save API and every co-op action,
  rejection, and connection event (see `docs/process/2026-10-17-c10-identity-logging.md`
  for the exact event list). `flyctl logs` is the access and retention
  mechanism — this is explicitly sufficient per the brief; no new
  database table, no promise of durable or queryable history beyond
  whatever Fly's own log pipeline retains. `actorId` is always the full,
  untruncated SHA-256 hex hash, never shortened for readability.

## Costs

- **Clearing cookies or switching browsers loses identity permanently.**
  There is no recovery by nickname — a display name is cosmetic and never
  deduplicates or reclaims a prior identity. This was already true under
  ADR 0002 and is unchanged here; it's restated because C10 makes identity
  itself the subject under test.
- **A room code is sensitive-ish.** Anyone who obtains it (a screenshot, a
  forwarded link, a leaked peek response before this fix) can join as a
  new anonymous identity. There is no password beyond the code's own
  32-character, 6-slot keyspace, and nothing revokes a leaked code except
  abandoning the room entirely.
- **Logs are single-process, stdout-only, and best-effort retained.** They
  are not a durable audit log, not queryable beyond grep/`flyctl logs`
  filtering, and can be lost if Fly's own log buffer rotates before anyone
  looks. This is accepted because the brief states `flyctl logs` tailing
  is sufficient — a stronger guarantee was not asked for and isn't built.
- **A full, untruncated actor id is verbose in a terminal.** This is
  accepted deliberately: a shortened id risks two different people's
  hashes looking alike at a glance during a live demo, which is exactly
  the confusion the brief warns against.
- **The peek endpoint still confirms a room's existence (and size) to an
  unauthenticated prober.** This is a deliberate, minimal, documented
  leak — join's own 404 already reveals existence this way, so hiding it
  at peek while revealing it at join would be an inconsistent partial fix
  for no real gain.
