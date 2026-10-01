# ADR 0001: Kaplay + Vite client, one Node process, SQLite on the volume

Status: accepted (crit 8), 2026-10-01

## Context

The game had grown as a browser-only Kaplay prototype through five playtest
iterations. Crit 8 needs it deployed on the course Fly setup (one
shared-cpu-1x machine, 256 MB, one volume at /data) with a server-side save,
and crit 9 will add a real-time shared layer. It has to work at 1920x1080 and
on a 390x844 phone.

## Options

1. **Keep the client, add a minimal Node server** (node:http, node:sqlite,
   Vite middleware in development).
2. **Move to a framework** (Astro/Next/Remix) with an API route layer.
3. **A hosted backend** (Firebase/Supabase) for saves.

## Decision

Option 1. The canvas game owns its own loop and doesn't benefit from a page
framework; the server needs four JSON endpoints, static files and /readme/.
`node:sqlite` ships with Node 24, so persistence adds no native dependency and
the image stays small (idle at ~44 MB). Node's type stripping runs
`server/*.ts` directly, so the server has no build step, and it imports the
same `src/save.ts` validator as the client. A hosted backend would put the
data outside the one volume the course setup gives us.

The HUD, hand and menus moved from canvas text to HTML over a full-window
canvas, because canvas text could only be scaled, not reflowed, for a phone.

## Costs

- No framework conventions: routing, body limits and cookies are hand-written
  (`server/index.ts`), so they need their own tests (`spec/saves.test.ts`).
- `node:sqlite` is still flagged experimental in Node 24 (the server hides the
  warning); the schema is three plain tables, so moving to better-sqlite3
  would be a small change if needed.
- One process with in-memory nothing: fine for saves, but crit 9's real-time
  layer will need a fan-out design (WebSocket or SSE) inside this process.
