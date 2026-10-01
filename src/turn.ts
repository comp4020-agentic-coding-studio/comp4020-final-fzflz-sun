export type Phase = "forming" | "playerTurn" | "resolving" | "unforming";
export type PhaseEvent = "formed" | "endTurn" | "flee" | "nextTurn" | "fleeEscaped" | "unformed";
export type RunState = "playing" | "dead" | "won";

const TRANSITIONS: Record<Phase, Partial<Record<PhaseEvent, Phase>>> = {
  forming: { formed: "playerTurn" },
  playerTurn: { endTurn: "resolving", flee: "resolving" },
  resolving: { nextTurn: "playerTurn", fleeEscaped: "unforming" },
  unforming: {},
};

/** Returns the next phase, or null when the event isn't allowed in this phase. */
export function transition(phase: Phase, ev: PhaseEvent): Phase | null {
  return TRANSITIONS[phase][ev] ?? null;
}

/** Card play, End Turn and Flee are all gated by this single check. */
export function canAct(phase: Phase | null, run: RunState): boolean {
  return phase === "playerTurn" && run === "playing";
}
