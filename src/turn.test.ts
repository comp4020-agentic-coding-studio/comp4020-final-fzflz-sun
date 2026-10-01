import { describe, expect, it } from "vitest";
import { type Phase, type PhaseEvent, canAct, transition } from "./turn.ts";

const PHASES: Phase[] = ["forming", "playerTurn", "resolving", "unforming"];
const EVENTS: PhaseEvent[] = ["formed", "endTurn", "flee", "nextTurn", "fleeEscaped", "unformed"];

describe("phase machine", () => {
  it("only the player turn of a live run accepts card / end turn / flee input", () => {
    for (const ph of PHASES) {
      expect(canAct(ph, "playing")).toBe(ph === "playerTurn");
      expect(canAct(ph, "dead")).toBe(false);
      expect(canAct(ph, "won")).toBe(false);
    }
    expect(canAct(null, "playing")).toBe(false);
  });

  it("a second End Turn during the resolve is rejected (no skipped turns)", () => {
    const resolving = transition("playerTurn", "endTurn");
    expect(resolving).toBe("resolving");
    expect(transition(resolving!, "endTurn")).toBeNull();
    expect(transition(resolving!, "flee")).toBeNull();
  });

  it("forming and unforming reject every combat input", () => {
    for (const ev of ["endTurn", "flee"] as const) {
      expect(transition("forming", ev)).toBeNull();
      expect(transition("unforming", ev)).toBeNull();
    }
  });

  it("walks a full fight: form, two turns, flee, escape", () => {
    let ph: Phase = "forming";
    for (const ev of ["formed", "endTurn", "nextTurn", "flee", "fleeEscaped"] as const) {
      const next = transition(ph, ev);
      expect(next, `${ph} --${ev}-->`).not.toBeNull();
      ph = next!;
    }
    expect(ph).toBe("unforming");
    for (const ev of EVENTS) expect(transition("unforming", ev)).toBeNull();
  });
});
