import { describe, expect, it } from "vitest";
import { type Phase, type PhaseEvent, canAct, planResolve, transition } from "./turn.ts";

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

describe("enemy resolve", () => {
  const atk = (value: number) => ({ kind: "attack" as const, value });

  it("dead enemies don't act", () => {
    const plan = planResolve({ hp: 20, block: 0 }, [
      { id: 1, alive: false, intent: atk(5) },
      { id: 2, alive: true, intent: atk(3) },
    ]);
    expect(plan.events.map((e) => e.id)).toEqual([2]);
    expect(plan.hp).toBe(17);
  });

  it("block soaks damage in order and the leftover is reported", () => {
    const plan = planResolve({ hp: 20, block: 5 }, [
      { id: 1, alive: true, intent: atk(3) },
      { id: 2, alive: true, intent: atk(4) },
    ]);
    expect(plan.events[0]).toMatchObject({ hpAfter: 20, blockAfter: 2, damageTaken: 0 });
    expect(plan.events[1]).toMatchObject({ hpAfter: 18, blockAfter: 0, damageTaken: 2 });
  });

  it("stops at the killing blow; later enemies never act", () => {
    const plan = planResolve({ hp: 6, block: 0 }, [
      { id: 1, alive: true, intent: atk(3) },
      { id: 2, alive: true, intent: atk(12) },
      { id: 3, alive: true, intent: { kind: "defend", value: 8 } },
    ]);
    expect(plan.died).toBe(true);
    expect(plan.hp).toBe(0);
    expect(plan.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it("defend and charge deal no damage", () => {
    const plan = planResolve({ hp: 10, block: 0 }, [
      { id: 1, alive: true, intent: { kind: "defend", value: 8 } },
      { id: 2, alive: true, intent: { kind: "charge", value: 0 } },
    ]);
    expect(plan.hp).toBe(10);
    expect(plan.events).toHaveLength(2);
  });
});
