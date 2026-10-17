import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { CoopClientMsg, CoopFightEndedMsg, CoopHelloMsg, CoopLeftFightMsg, CoopServerMsg } from "../../src/coop-protocol.ts";
import { HttpError, json, parseCookies, readBody } from "../http.ts";
import { CALM_TIME } from "../../src/roam.ts";
import { FightSession, migratePersistedFight, type FightAction } from "./fight-session.ts";
import { CoopRoom, MEMBER_COLORS, type RoomEnemy } from "./room.ts";
import { openCoopStore, type CoopStore } from "./store.ts";

// The co-op layer: a WebSocket per connected player, a room per shared
// expedition, ticked on one shared interval and broadcast to every socket in
// that room. REST (`/api/coop/rooms`...) creates/joins a room and establishes
// the player's identity cookie; the socket itself (`/coop/ws?code=`) only
// works once that identity is already a member (joining always goes through
// REST first, same-origin, so the cookie is already set by the time the
// browser opens the socket).
const COOKIE = "cc_coop";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L: read aloud or typed from a phone
const CODE_LEN = 6;
const TICK_MS = 150;
const SAVE_DEBOUNCE_MS = 2000;
const NAME_MAX = 24;
/** A disconnect mid-fight gets this long to reconnect before it's resolved as a normal, costed flee. */
const RECONNECT_WINDOW_MS = 30_000;

/**
 * Opt-in (COOP_PERF_LOG=1), off by default: periodic plain-text summaries of
 * tick/persist duration and event-loop lag, so a performance claim can point
 * at real numbers instead of a guess. Never affects behavior when unset.
 */
const PERF_LOG = process.env.COOP_PERF_LOG === "1";
class RollingStats {
  private vals: number[] = [];
  push(v: number) {
    this.vals.push(v);
    if (this.vals.length > 2000) this.vals.shift();
  }
  summary(): string {
    if (!this.vals.length) return "n=0";
    const sorted = [...this.vals].sort((a, b) => a - b);
    const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];
    this.vals = [];
    return `n=${sorted.length} avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`;
  }
}

function newCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return out;
}

function cleanName(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.trim().slice(0, NAME_MAX) : "";
  return s || fallback;
}

interface PersistedRoom {
  players: { id: string; x: number; y: number; hp: number }[];
  enemies: { key: string; x: number; y: number; cx: number; cy: number; state: string; targetId: string | null; hp: number; phase: number; alive: boolean }[];
}

export class CoopServer {
  private store: CoopStore;
  private rooms = new Map<string, CoopRoom>();
  private sockets = new Map<string, Set<{ ws: WebSocket; playerId: string }>>();
  /** keyed by `${roomCode}:${playerId}`: bumped every time a connection is accepted for that player, so a replaced
   * socket's own close handler (which fires asynchronously, possibly after the new one already connected) can tell
   * it's no longer current and must not mark the player offline or arm a reconnect timer for a connection that's
   * actually still live. */
  private connGen = new Map<string, number>();
  private lastSaved = new Map<string, number>();
  /** keyed by `${roomCode}:${fightId}`, since a RoomFight's id is only unique within its own room. */
  private sessions = new Map<string, FightSession>();
  /**
   * keyed by `${roomCode}:${fightId}`: a fight whose terminal state
   * (win/wipe/abandon) is decided in memory but whose database commit
   * (store.finishFight) hasn't succeeded yet. Nobody is told the fight
   * ended, and the session isn't discarded, until it actually commits —
   * retried every tick (see tickAll) rather than left to fail silently
   * forever. While any entry for a room is pending, that room's own
   * periodic debounced snapshot write is skipped (tickAll), so it can never
   * record the fight as over while the `fights` table still holds its row.
   */
  private pendingFinishes = new Map<string, { room: CoopRoom; fightId: string; session: FightSession; initialMembers: string[] }>();
  /** keyed by `${roomCode}:${playerId}`: a running reconnect-window countdown for someone who disconnected mid-fight. */
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private timer: ReturnType<typeof setInterval>;
  private tickDurations = new RollingStats();
  private persistDurations = new RollingStats();
  private loopLag = new RollingStats();
  private perfTimer?: ReturnType<typeof setInterval>;
  private lagProbeTimer?: ReturnType<typeof setInterval>;

  /** `store`, when given, replaces the real SQLite-backed one — used only by tests that need to inject a store wrapper (e.g. to force `finishFight` to fail on demand) without duplicating this class's wiring. */
  constructor(dataDir: string, store?: CoopStore) {
    this.store = store ?? openCoopStore(dataDir);
    this.timer = setInterval(() => this.tickAll(), TICK_MS).unref();
    if (PERF_LOG) {
      let lastProbe = Date.now();
      this.lagProbeTimer = setInterval(() => {
        const now = Date.now();
        this.loopLag.push(Math.max(0, now - lastProbe - TICK_MS));
        lastProbe = now;
      }, TICK_MS).unref();
      this.perfTimer = setInterval(() => {
        console.log(
          `[coop-perf] tick: ${this.tickDurations.summary()} | persist: ${this.persistDurations.summary()} | loop-lag: ${this.loopLag.summary()} | rooms=${this.rooms.size}`,
        );
      }, 5000).unref();
    }
  }

  private identityFor(req: IncomingMessage, res?: ServerResponse): string {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) return createHash("sha256").update(token).digest("hex");
    if (!res) throw new HttpError(401, "no co-op identity: use the REST join endpoint first");
    const fresh = randomBytes(32).toString("base64url");
    const secure = req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("set-cookie", `${COOKIE}=${fresh}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`);
    return createHash("sha256").update(fresh).digest("hex");
  }

  private colorFor(code: string, playerId: string): string {
    const existing = this.rooms.get(code)?.players.get(playerId);
    if (existing) return existing.color;
    const n = this.store.members(code).length;
    return MEMBER_COLORS[n % MEMBER_COLORS.length];
  }

  private getOrLoadRoom(code: string): CoopRoom | null {
    const live = this.rooms.get(code);
    if (live) return live;
    if (!this.store.roomExists(code)) return null;
    const room = new CoopRoom(code, Date.now());
    const now = Date.now();
    for (const m of this.store.members(code)) room.addPlayer(m.playerId, m.name, m.color, now);
    const raw = this.store.getState(code);
    if (raw) {
      try {
        restore(room, JSON.parse(raw) as PersistedRoom);
      } catch {
        // a corrupt or pre-release snapshot: start this room's world fresh rather than fail the join
      }
    }
    for (const p of room.players.values()) p.online = false; // nobody has an open socket yet

    // Reconstruct any fight that was still in progress when the server last
    // stopped: full hands, round, energy and card instance ids, exactly
    // where they were (server/coop/fight-session.ts's restore path) — not
    // re-dealt, not re-resolved, not re-confirmed.
    const resumed = new Set<string>();
    for (const row of this.store.fights(code)) {
      try {
        const parsed: unknown = JSON.parse(row.data);
        // a row written by the code that existed between 3c658ca (added fight
        // persistence) and b2896df (added hp/ready) has neither field, and no
        // `version` at all — migrate it to a fully-valid shape (or get `null`
        // back if it's too structurally broken to use), rather than trusting
        // the raw JSON's shape unconditionally.
        const data = migratePersistedFight(parsed, room);
        if (!data) continue; // falls through to the orphan-cleanup pass below
        const rf = data.roomFight;
        if (rf.enemyKeys.some((k) => !room.enemies.find((e) => e.key === k))) continue; // map changed under it: can't resume
        room.fights.set(rf.id, rf);
        room.reserveFightId(rf.id); // the next genuinely new fight must never reuse this id
        const session = new FightSession(room, rf, Math.random, data);
        this.sessions.set(sessionKey(code, rf.id), session);
        resumed.add(rf.id);
        for (const key of rf.enemyKeys) {
          const e = room.enemies.find((x) => x.key === key)!;
          e.state = "engaged";
          e.fightId = rf.id;
        }
        // session.playerIds is the fight's *actual current* membership — it
        // already excludes anyone who'd successfully fled before the crash
        // (and includes a downed player, who's still structurally part of the
        // fight). rf.playerIds is the fight's original, fixed roster, which
        // never shrinks when someone leaves — using it here would re-lock an
        // already-fled player back into a fight they're no longer in.
        for (const pid of session.playerIds) {
          const rp = room.players.get(pid);
          if (rp) rp.fightId = rf.id;
        }
        // Nobody has an open socket right now — this is a cold room load, not a
        // live disconnect — but the effect for each actual participant is the
        // same: give them the normal reconnect window rather than instantly
        // treating a restart as a mass flee.
        for (const pid of session.playerIds) this.armReconnectTimer(room, pid);
      } catch {
        // a corrupt fight row: fall through to the orphan-cleanup pass below instead of resuming it
      }
    }

    // Compatibility: a legacy room_state snapshot (from before fight
    // persistence existed) or a fight row that failed to resume can still
    // leave an enemy marked "engaged" with nothing left to finish that fight
    // — free it back to roaming rather than leaving it stuck forever, and
    // never wipe the rest of the room to do it.
    for (const e of room.enemies) {
      if (e.state === "engaged" && (!e.fightId || !resumed.has(e.fightId))) {
        e.state = "calm";
        e.stateUntil = now / 1000 + CALM_TIME;
        e.wanderTarget = null;
        e.targetId = null;
        e.fightId = null;
      }
    }
    for (const p of room.players.values()) {
      if (p.fightId && !resumed.has(p.fightId)) p.fightId = null;
    }

    this.rooms.set(code, room);
    return room;
  }

  // ---------- REST: create / join / peek ----------

  async handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path === "/api/coop/rooms" && req.method === "POST") {
      const playerId = this.identityFor(req, res);
      const body = (await readBody(req)) as { name?: unknown };
      const code = newCode();
      const now = Date.now();
      this.store.createRoom(code, now);
      const color = MEMBER_COLORS[0];
      const name = cleanName(body.name, "Explorer 1");
      this.store.upsertMember(code, playerId, name, color, now);
      const room = this.getOrLoadRoom(code)!;
      room.addPlayer(playerId, name, color, now);
      json(res, 200, { code, name, color });
      return true;
    }

    const joinMatch = path.match(/^\/api\/coop\/rooms\/([A-Z0-9]{6})\/join$/);
    if (joinMatch && req.method === "POST") {
      const code = joinMatch[1];
      if (!this.store.roomExists(code)) throw new HttpError(404, "no such room: check the code or link");
      const playerId = this.identityFor(req, res);
      const body = (await readBody(req)) as { name?: unknown };
      const now = Date.now();
      const color = this.colorFor(code, playerId);
      const existingMember = this.store.members(code).find((m) => m.playerId === playerId);
      const name = cleanName(body.name, existingMember?.name ?? `Explorer ${this.store.members(code).length + 1}`);
      this.store.upsertMember(code, playerId, name, color, now);
      const room = this.getOrLoadRoom(code)!;
      room.addPlayer(playerId, name, color, now);
      room.setOnline(playerId, false, now); // online only once the socket actually connects
      json(res, 200, {
        code,
        name,
        color,
        members: this.store.members(code).map((m) => ({ id: m.playerId, name: m.name, color: m.color })),
      });
      return true;
    }

    const peekMatch = path.match(/^\/api\/coop\/rooms\/([A-Z0-9]{6})$/);
    if (peekMatch && req.method === "GET") {
      const code = peekMatch[1];
      if (!this.store.roomExists(code)) throw new HttpError(404, "no such room: check the code or link");
      json(res, 200, { code, members: this.store.members(code).map((m) => ({ id: m.playerId, name: m.name, color: m.color })) });
      return true;
    }

    return false;
  }

  // ---------- WebSocket upgrade ----------

  attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(req.url ?? "", "http://local");
      if (url.pathname !== "/coop/ws") return; // not ours: leave it for anything else that might attach later
      let playerId: string;
      try {
        playerId = this.identityFor(req);
      } catch {
        socket.destroy();
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const room = this.getOrLoadRoom(code);
      const member = room?.players.get(playerId);
      if (!room || !member) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(room, playerId, ws));
    });
  }

  private onConnect(room: CoopRoom, playerId: string, ws: WebSocket) {
    const now = Date.now();
    room.setOnline(playerId, true, now);
    this.cancelReconnectTimer(room.code, playerId); // back before the window ran out: nothing to resolve
    const entry = { ws, playerId };
    let set = this.sockets.get(room.code);
    if (!set) this.sockets.set(room.code, (set = new Set()));
    // the same identity opening a second tab replaces the stale socket; it never
    // gets a second character in the room.
    for (const other of set) if (other.playerId === playerId && other.ws !== ws) other.ws.close(4000, "replaced by another tab");
    set.add(entry);
    // This connection is now the current one for this player; a later close of
    // an older, already-replaced socket (whose close event can still arrive
    // after this point) must not undo that.
    const genKey = `${room.code}:${playerId}`;
    const myGen = (this.connGen.get(genKey) ?? 0) + 1;
    this.connGen.set(genKey, myGen);

    const hello: CoopHelloMsg = {
      type: "hello",
      selfId: playerId,
      room: { code: room.code, members: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color })) },
      fightId: room.players.get(playerId)?.fightId ?? null,
    };
    ws.send(JSON.stringify(hello));

    // reconnecting (or first connecting) mid-fight: catch this socket up immediately
    const fightId = room.players.get(playerId)?.fightId;
    if (fightId) {
      const session = this.sessions.get(sessionKey(room.code, fightId));
      if (session) {
        this.sendTo(room, playerId, session.fightView());
        const hand = session.handView(playerId);
        if (hand) this.sendTo(room, playerId, hand);
      }
    }

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const m = msg as Partial<CoopClientMsg>;
      if (m.type === "move" && typeof m.dx === "number" && typeof m.dy === "number" && Number.isFinite(m.dx) && Number.isFinite(m.dy)) {
        const dx = Math.max(-1, Math.min(1, m.dx));
        const dy = Math.max(-1, Math.min(1, m.dy));
        room.setIntent(playerId, dx, dy, Date.now());
        return;
      }
      if ((m.type === "playCard" || m.type === "endTurn" || m.type === "flee") && typeof m.seq === "number") {
        this.handleFightAction(room, playerId, m.seq, msg as { type: string } & Record<string, unknown>);
      }
    });

    // idempotent: "close" and "error" can both fire for the same socket, and must only ever undo this exact connect once
    let closed = false;
    const onClose = () => {
      if (closed) return;
      closed = true;
      set!.delete(entry);
      // a second tab already replaced this connection (this fired after that
      // newer onConnect already bumped the generation): the player is still
      // online through the new socket, so don't mark them offline or start a
      // reconnect countdown for a "disconnect" that never really happened.
      if (this.connGen.get(genKey) !== myGen) return;
      room.setOnline(playerId, false, Date.now());
      if (set!.size === 0) this.sockets.delete(room.code);
      if (room.players.get(playerId)?.fightId) this.armReconnectTimer(room, playerId);
    };
    ws.on("close", onClose);
    ws.on("error", onClose);
  }

  /** Mid-fight disconnect: give them RECONNECT_WINDOW_MS to come back before it resolves as a normal, costed flee. */
  private armReconnectTimer(room: CoopRoom, playerId: string) {
    const key = sessionKey(room.code, playerId);
    this.cancelReconnectTimer(room.code, playerId);
    this.reconnectTimers.set(
      key,
      setTimeout(() => {
        this.reconnectTimers.delete(key);
        const member = room.players.get(playerId);
        if (!member || member.online) return; // reconnected (or left) through some other path already
        const fightId = member.fightId;
        if (!fightId) return; // the fight they were in already ended on its own
        const session = this.sessions.get(sessionKey(room.code, fightId));
        if (!session) return;
        const initialMembers = session.initialPlayerIds;
        session.forceFlee(playerId, Date.now() / 1000, Math.random);
        this.afterFightChange(room, fightId, session, initialMembers);
      }, RECONNECT_WINDOW_MS).unref(),
    );
  }

  private cancelReconnectTimer(roomCode: string, playerId: string) {
    const key = sessionKey(roomCode, playerId);
    const t = this.reconnectTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.reconnectTimers.delete(key);
    }
  }

  private handleFightAction(room: CoopRoom, playerId: string, seq: number, raw: { type: string } & Record<string, unknown>) {
    const fightId = room.players.get(playerId)?.fightId;
    if (!fightId) return this.sendTo(room, playerId, { type: "actionError", error: "you're not in a fight right now" });
    const session = this.sessions.get(sessionKey(room.code, fightId));
    if (!session) return this.sendTo(room, playerId, { type: "actionError", error: "that fight no longer exists" });

    let action: FightAction;
    if (raw.type === "playCard" && typeof raw.cardInstanceId === "string") {
      action = { type: "playCard", cardInstanceId: raw.cardInstanceId, targetKey: typeof raw.targetKey === "string" ? raw.targetKey : undefined };
    } else if (raw.type === "endTurn") {
      action = { type: "endTurn" };
    } else if (raw.type === "flee") {
      action = { type: "flee" };
    } else {
      return this.sendTo(room, playerId, { type: "actionError", error: "malformed action" });
    }

    const initialMembers = session.initialPlayerIds;
    const result = session.applyAction(playerId, seq, action, Date.now() / 1000, Math.random);
    if (!result.ok) {
      this.sendTo(room, playerId, { type: "actionError", error: result.error ?? "rejected" });
      // a stale/duplicate seq or an action against state that already moved on: push the
      // authoritative view back so the client self-heals instead of the player needing to
      // guess-and-retry their way back in sync.
      this.sendTo(room, playerId, session.fightView());
      const hand = session.handView(playerId);
      if (hand) this.sendTo(room, playerId, hand);
      return;
    }
    this.afterFightChange(room, fightId, session, initialMembers);
  }

  /** Pushes the right follow-up views after anything changes a fight's state: client action, or a forced flee. */
  private afterFightChange(room: CoopRoom, fightId: string, session: FightSession, initialMembers: string[]) {
    if (session.ended) {
      // The fight's terminal state (win/wipe/abandon — one path for all three,
      // since `finish()` already produced one consistent in-memory shape) must
      // be durable as a single atomic unit — deleting the fight row and
      // writing the final room snapshot separately could leave a crash with
      // "fight gone, room stale" or the reverse — and nobody should be told
      // it happened before that commit actually succeeds. A failed commit
      // marks this fight "pending" instead of proceeding anyway: no false
      // success notification, the session isn't discarded, and tickAll retries
      // the exact same commit every tick (and skips this room's own periodic
      // snapshot write meanwhile, so it can never persist the fight as over
      // while the `fights` table still holds the row) until it actually
      // succeeds. Nobody can act against this fight in the meantime regardless
      // — applyAction already rejects anything once `session.ended` is set.
      if (this.tryFinishFight(room, fightId, session, initialMembers)) return;
      this.pendingFinishes.set(sessionKey(room.code, fightId), { room, fightId, session, initialMembers });
    } else {
      // someone who personally left (an individual flee) this round, while the fight
      // itself continues for the rest: they get no fightEnded, so they need their own
      // explicit "you're out" message or their client would keep showing the stale dock.
      for (const pid of session.takeJustLeft()) {
        const left: CoopLeftFightMsg = { type: "leftFight", fightId: session.id, outcome: "fled" };
        this.sendTo(room, pid, left);
      }
      const view = session.fightView();
      for (const pid of session.playerIds) {
        this.sendTo(room, pid, view);
        const hand = session.handView(pid);
        if (hand) this.sendTo(room, pid, hand);
      }
      // the action that got us here (a card played, a round resolved, a flee taken) is now
      // fully complete — persist it as one atomic write before confirming anything further,
      // never mid-effect, so a restart can resume from exactly here.
      this.persistFight(room.code, session);
    }
    this.broadcastState(room); // block/ready/hp changed: don't make the room wait for the next tick
  }

  /**
   * Attempts the atomic commit + notification for one already-concluded
   * fight. Returns true only once that commit actually succeeds (and the
   * notification/session-cleanup has happened); false means the fight is
   * still pending and must be retried later — the caller must not treat
   * false as success.
   */
  private tryFinishFight(room: CoopRoom, fightId: string, session: FightSession, initialMembers: string[]): boolean {
    const now = Date.now();
    const roomStateJson = JSON.stringify(persist(room));
    try {
      this.store.finishFight(room.code, fightId, roomStateJson, now);
    } catch (e) {
      console.error(`[coop] finishFight failed for ${room.code}:${fightId}, will retry next tick:`, e);
      return false;
    }
    this.lastSaved.set(room.code, now);
    const ended: CoopFightEndedMsg = { type: "fightEnded", fightId: session.id, outcome: session.ended! };
    // `initialMembers` (the fight's original, fixed roster) is too broad: it
    // still includes anyone who personally left earlier via an individual
    // flee, who may since have joined a different, unrelated fight — notifying
    // them here is exactly the bug (a message about fight X landing on a
    // client legitimately showing fight Y). `session.finalPlayerIds` is
    // captured by FightSession.finish() at the exact moment this fight
    // concluded, before anything clears it — the correct, final membership.
    for (const pid of session.finalPlayerIds ?? initialMembers) this.sendTo(room, pid, ended);
    this.sessions.delete(sessionKey(room.code, fightId));
    this.pendingFinishes.delete(sessionKey(room.code, fightId));
    return true;
  }

  private persistFight(roomCode: string, session: FightSession) {
    this.store.putFight(roomCode, session.id, JSON.stringify(session.serialize()), Date.now());
  }

  private sendTo(room: CoopRoom, playerId: string, msg: CoopServerMsg) {
    const sockets = this.sockets.get(room.code);
    if (!sockets) return;
    const data = JSON.stringify(msg);
    for (const s of sockets) if (s.playerId === playerId && s.ws.readyState === WebSocket.OPEN) s.ws.send(data);
  }

  private broadcastState(room: CoopRoom) {
    const sockets = this.sockets.get(room.code);
    if (!sockets || sockets.size === 0) return;
    const msg: CoopServerMsg = { type: "state", ...room.snapshot(Date.now()) };
    broadcast(sockets, msg);
  }

  // ---------- shared tick loop ----------

  /** Test-only: runs one tick synchronously instead of waiting for the real interval, so a test can assert on its effects deterministically. */
  runTickForTest(): void {
    this.tickAll();
  }

  /** Test-only: drives the same fight-conclusion path the real action/reconnect-timeout handlers use, without needing a real WebSocket action. */
  testAfterFightChange(room: CoopRoom, fightId: string, session: FightSession, initialMembers: string[]): void {
    this.afterFightChange(room, fightId, session, initialMembers);
  }

  /** Test-only: registers a room the same way getOrLoadRoom would, so tickAll can find it without a real REST create/join flow. */
  testRegisterRoom(room: CoopRoom): void {
    this.rooms.set(room.code, room);
  }

  /** Test-only: registers a fake, always-open socket for a player and returns the array every message sent to it lands in, so a test can assert exactly what was (or wasn't) notified. */
  testRegisterFakeSocket(roomCode: string, playerId: string): CoopServerMsg[] {
    const sent: CoopServerMsg[] = [];
    const fakeWs = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(JSON.parse(data) as CoopServerMsg) } as unknown as WebSocket;
    let set = this.sockets.get(roomCode);
    if (!set) this.sockets.set(roomCode, (set = new Set()));
    set.add({ ws: fakeWs, playerId });
    return sent;
  }

  testHasSession(code: string, fightId: string): boolean {
    return this.sessions.has(sessionKey(code, fightId));
  }

  testPendingFinishCount(): number {
    return this.pendingFinishes.size;
  }

  private tickAll() {
    const t0 = PERF_LOG ? performance.now() : 0;
    const now = Date.now();
    // Retry any fight whose terminal commit failed last time, independent of
    // whether its room currently has any connected sockets (a retry must not
    // wait for someone to be watching) — each successful retry removes itself
    // from pendingFinishes via tryFinishFight.
    if (this.pendingFinishes.size > 0) {
      for (const { room, fightId, session, initialMembers } of [...this.pendingFinishes.values()]) {
        this.tryFinishFight(room, fightId, session, initialMembers);
      }
    }
    for (const [code, room] of this.rooms) {
      const sockets = this.sockets.get(code);
      if (!sockets || sockets.size === 0) continue; // nobody connected: don't simulate or broadcast an empty room
      const { newFights } = room.tick(now / 1000, TICK_MS / 1000, Math.random);
      for (const rf of newFights) {
        const session = new FightSession(room, rf, Math.random);
        this.sessions.set(sessionKey(code, rf.id), session);
        const view = session.fightView();
        for (const pid of session.playerIds) {
          this.sendTo(room, pid, view);
          const hand = session.handView(pid);
          if (hand) this.sendTo(room, pid, hand);
        }
        // persist the freshly-dealt opening state immediately: a crash before anyone's
        // first action must still resume this fight, not drop it.
        this.persistFight(code, session);
      }
      this.broadcastState(room);
      const last = this.lastSaved.get(code) ?? 0;
      // A room with a still-pending finish must not have its own periodic
      // snapshot write fire in the meantime: the in-memory room already
      // reflects the fight as over (FightSession.finish() applied that before
      // the commit was even attempted), so writing it now — while the
      // `fights` table still holds that fight's row, because the commit that
      // would remove it hasn't succeeded yet — would create exactly the
      // inconsistency this mechanism exists to prevent.
      const roomHasPendingFinish = [...this.pendingFinishes.values()].some((p) => p.room === room);
      if (now - last >= SAVE_DEBOUNCE_MS && !roomHasPendingFinish) {
        this.lastSaved.set(code, now);
        const p0 = PERF_LOG ? performance.now() : 0;
        this.store.putState(code, JSON.stringify(persist(room)), now);
        if (PERF_LOG) this.persistDurations.push(performance.now() - p0);
      }
    }
    if (PERF_LOG) this.tickDurations.push(performance.now() - t0);
  }

  close() {
    clearInterval(this.timer);
    if (this.perfTimer) clearInterval(this.perfTimer);
    if (this.lagProbeTimer) clearInterval(this.lagProbeTimer);
    for (const t of this.reconnectTimers.values()) clearTimeout(t);
    this.reconnectTimers.clear();
    this.store.close();
  }
}

function sessionKey(roomCode: string, fightId: string): string {
  return `${roomCode}:${fightId}`;
}

function broadcast(sockets: Set<{ ws: WebSocket; playerId: string }>, msg: CoopServerMsg) {
  const data = JSON.stringify(msg);
  for (const { ws } of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function persist(room: CoopRoom): PersistedRoom {
  return {
    players: [...room.players.values()].map((p) => ({ id: p.id, x: p.pos.x, y: p.pos.y, hp: p.hp })),
    enemies: room.enemies.map((e) => ({
      key: e.key, x: e.pos.x, y: e.pos.y, cx: e.center.x, cy: e.center.y, state: e.state, targetId: e.targetId, hp: e.hp, phase: e.phase, alive: e.alive,
    })),
  };
}

function restore(room: CoopRoom, data: PersistedRoom) {
  const byKey = new Map(room.enemies.map((e) => [e.key, e]));
  for (const saved of data.enemies ?? []) {
    const e = byKey.get(saved.key) as RoomEnemy | undefined;
    if (!e) continue;
    e.pos = { x: saved.x, y: saved.y };
    e.center = { x: saved.cx, y: saved.cy };
    e.state = saved.state as RoomEnemy["state"];
    e.targetId = saved.targetId;
    e.hp = saved.hp;
    e.phase = saved.phase ?? 0;
    // a pre-this-fix snapshot has no `alive` field at all: default true, since
    // that's the only safe reading of data captured before dead enemies were
    // ever tracked — but once a snapshot does have it, a confirmed kill must
    // never come back, matching src/roam.ts/src/save.ts's same rule for solo.
    e.alive = saved.alive ?? true;
  }
  for (const saved of data.players ?? []) {
    const p = room.players.get(saved.id);
    if (!p) continue; // a snapshot's player who's since left the member list: nothing to restore onto
    p.pos = { x: saved.x, y: saved.y };
    p.hp = saved.hp;
  }
}

export function attachCoop(server: Server, dataDir: string): CoopServer {
  const coop = new CoopServer(dataDir);
  coop.attach(server);
  return coop;
}
