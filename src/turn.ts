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

export type IntentKind = "attack" | "defend" | "charge";
export interface Intent {
  kind: IntentKind;
  value: number;
}

export interface ResolveActor {
  id: number;
  alive: boolean;
  intent: Intent | null;
}

export interface ResolveEvent {
  id: number;
  intent: Intent;
  hpAfter: number;
  blockAfter: number;
  damageTaken: number;
}

export interface ResolvePlan {
  events: ResolveEvent[];
  died: boolean;
  hp: number;
  block: number;
}

/**
 * Plans one enemy resolve in roster order. Dead actors are skipped, and the
 * plan stops at the action that kills the player, so nothing after it runs.
 */
export function planResolve(player: { hp: number; block: number }, actors: ResolveActor[]): ResolvePlan {
  let hp = player.hp;
  let block = player.block;
  const events: ResolveEvent[] = [];
  for (const a of actors) {
    if (!a.alive || !a.intent) continue;
    let damageTaken = 0;
    if (a.intent.kind === "attack") {
      const absorbed = Math.min(block, a.intent.value);
      block -= absorbed;
      damageTaken = a.intent.value - absorbed;
      hp = Math.max(0, hp - damageTaken);
    }
    events.push({ id: a.id, intent: a.intent, hpAfter: hp, blockAfter: block, damageTaken });
    if (hp <= 0) return { events, died: true, hp, block };
  }
  return { events, died: false, hp, block };
}
