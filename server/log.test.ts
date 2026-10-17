import { describe, expect, it } from "vitest";
import { formatLogLine, nullSink, stdoutSink, type LogEvent } from "./log.ts";

const base: LogEvent = { event: "coop.room.create", ts: 0, result: "ok" };

describe("formatLogLine", () => {
  it("produces a single valid JSON line for a normal event", () => {
    const line = formatLogLine({ ...base, identityNs: "coop", actorId: "abc123", actorName: "Ash", roomId: "ROOM01" });
    expect(line.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(line) as LogEvent;
    expect(parsed).toEqual({ ...base, identityNs: "coop", actorId: "abc123", actorName: "Ash", roomId: "ROOM01" });
  });

  it("round-trips every optional field when present", () => {
    const e: LogEvent = {
      event: "coop.fight.card",
      ts: 12345,
      identityNs: "coop",
      actorId: "a".repeat(64),
      actorName: "Birch",
      roomId: "R1",
      fightId: "f1",
      targetId: "other-player",
      seq: 3,
      connId: "c1",
      requestId: "req1",
      result: "ok",
      reason: "card_not_in_hand",
      summary: { cardKind: "single", downed: false, count: 2 },
    };
    const parsed = JSON.parse(formatLogLine(e)) as LogEvent;
    expect(parsed).toEqual(e);
  });

  it("omits absent optional fields rather than serializing them as null/undefined", () => {
    const line = formatLogLine({ event: "coop.room.peek", ts: 1, result: "ok" });
    expect(line).not.toMatch(/actorId|identityNs|roomId/);
  });

  // The same marker used in tools/coop-xss-check.mjs, for continuity: proves a
  // name crafted to execute as HTML is equally harmless as a log field — it's
  // just a string JSON.stringify escapes like any other.
  const XSS_NAME = `<img src=x onerror="console.log('__XSS_FIRED__')">`;

  it("a crafted actorName (HTML/script-shaped) still produces exactly one valid JSON line", () => {
    const line = formatLogLine({ ...base, actorName: XSS_NAME });
    expect(line.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(line) as LogEvent;
    expect(parsed.actorName).toBe(XSS_NAME);
  });

  it("an actorName containing newlines and quotes still produces exactly one valid JSON line", () => {
    const name = 'line one\nline two\r\nline three "quoted" \\backslash\\';
    const line = formatLogLine({ ...base, actorName: name });
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).actorName).toBe(name);
  });

  it("an actorName shaped like a fake adjacent log line cannot forge one", () => {
    // if this were ever naively concatenated instead of JSON-encoded, this
    // payload would try to close the real object early and open a fake one
    // claiming a different event/result.
    const name = `}{"event":"coop.fight.ended","result":"ok","forged":true}`;
    const line = formatLogLine({ ...base, actorName: name });
    expect(line.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(line) as LogEvent;
    // it's just the literal string value of actorName — not a second event
    expect(parsed.actorName).toBe(name);
    expect(parsed.event).toBe("coop.room.create");
  });

  it("does not assume a bound: an overlong field still produces one safe line", () => {
    // truncation is cleanName's job upstream, not log.ts's — this is defense
    // in depth, not a claim that log.ts itself truncates.
    const long = "x".repeat(10_000);
    const line = formatLogLine({ ...base, actorName: long });
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).actorName).toBe(long);
  });
});

describe("sinks", () => {
  it("stdoutSink's log is callable and formats via formatLogLine", () => {
    const calls: string[] = [];
    const orig = console.log;
    console.log = (s: string) => calls.push(s);
    try {
      stdoutSink().log({ ...base, actorId: "xyz" });
    } finally {
      console.log = orig;
    }
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]).actorId).toBe("xyz");
  });

  it("nullSink does nothing observable", () => {
    expect(() => nullSink().log(base)).not.toThrow();
  });
});
