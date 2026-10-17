// Business/audit logging, shared by the solo save API (server/index.ts) and
// the co-op layer (server/coop/ws.ts): JSON-lines to stdout, picked up by
// Fly's own log pipeline (`flyctl logs`) — the brief's own explicitly-stated
// sufficient persistence/access mechanism, not a new database table. See
// docs/adr/0007-coop-identity-and-permissions.md for the decision and its
// costs.
//
// Kept pure-formatting-first (formatLogLine has no I/O) so it's unit
// testable without a server, matching this project's own "keep rules
// testable, separate from the DOM/transport" discipline. The sink is a tiny
// injectable interface so CoopServer can take a capturing one in tests the
// same way it already takes an injectable store.

export interface LogEvent {
  event: string;
  /** injected, never read internally, so a test can assert on an exact value */
  ts: number;
  /** absent for an event with no resolved actor yet (e.g. an unauthenticated peek) */
  identityNs?: "visitor" | "coop";
  /** full SHA-256 hex, never truncated — see the ADR: a shortened id risks two different people looking alike in a live demo */
  actorId?: string;
  actorName?: string;
  roomId?: string;
  fightId?: string;
  /** another player's id an action concerns (e.g. who was downed, who a rejected action named) */
  targetId?: string;
  seq?: number;
  connId?: string;
  requestId?: string;
  result: "ok" | "rejected" | "error";
  /** a small fixed reason code, never raw free text echoing arbitrary input */
  reason?: string;
  /** bounded extra fields only — never a full hand, save blob, or request body */
  summary?: Record<string, number | string | boolean | null>;
}

/**
 * Pure: JSON.stringify of the event, field order as given. JSON string
 * escaping already guarantees a crafted actorName/reason (newlines, quotes,
 * a fake `}{"event":...` fragment) can never break line-based parsing or
 * forge an adjacent line — server/log.test.ts proves this rather than
 * assuming it.
 */
export function formatLogLine(e: LogEvent): string {
  return JSON.stringify(e);
}

export interface LogSink {
  log(e: LogEvent): void;
}

export function stdoutSink(): LogSink {
  return {
    log(e) {
      console.log(formatLogLine(e));
    },
  };
}

export function nullSink(): LogSink {
  return { log() {} };
}
