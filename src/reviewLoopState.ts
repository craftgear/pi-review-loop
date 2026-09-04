export const DEFAULT_MAX_ROUNDS = 10;
export const MAX_MAX_ROUNDS = 10;

export type ReviewLoopPhase =
  | "idle"
  | "reviewing"
  | "fixing"
  | "completed"
  | "stopped";
export type ReviewLoopCompletionReason = "no_changes" | "max_rounds";
export type ReviewLoopStopReason =
  | "abort"
  | "shutdown"
  | "protocol_error";

export interface ReviewLoopState {
  phase: ReviewLoopPhase;
  round: number;
  maxRounds: number;
  completionReason?: ReviewLoopCompletionReason;
  stopReason?: ReviewLoopStopReason;
}

export type ReviewLoopNextAction = "review" | "completed" | "stopped";

export interface ReviewLoopTransition {
  next: ReviewLoopNextAction;
  state: ReviewLoopState;
}

function normalizeMaxRounds(maxRounds: number | undefined): number {
  const value = maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_MAX_ROUNDS) {
    throw new RangeError(`maxRounds must be between 1 and ${MAX_MAX_ROUNDS}`);
  }
  return value;
}

export function createIdleState(maxRounds?: number): ReviewLoopState {
  return {
    phase: "idle",
    round: 0,
    maxRounds: normalizeMaxRounds(maxRounds),
  };
}

export function startLoop(maxRounds?: number): ReviewLoopState {
  return {
    phase: "reviewing",
    round: 1,
    maxRounds: normalizeMaxRounds(maxRounds),
  };
}

export function isReviewLoopActive(state: ReviewLoopState): boolean {
  return state.phase === "reviewing" || state.phase === "fixing";
}

function requireActive(state: ReviewLoopState): void {
  if (!isReviewLoopActive(state)) {
    throw new Error(`Review loop is not active: ${state.phase}`);
  }
}

export function enterFixing(state: ReviewLoopState): ReviewLoopState {
  requireActive(state);
  if (state.phase !== "reviewing") {
    throw new Error("A fixing phase requires a reviewing phase");
  }
  return {
    ...state,
    phase: "fixing",
  };
}

export function finishFix(
  state: ReviewLoopState,
  changed: boolean,
): ReviewLoopTransition {
  requireActive(state);
  if (state.phase !== "fixing") {
    throw new Error("A fix result requires a fixing phase");
  }
  if (!changed) {
    return {
      next: "completed",
      state: {
        ...state,
        phase: "completed",
        completionReason: "no_changes",
      },
    };
  }
  return {
    next: "review",
    state: {
      ...state,
      phase: "reviewing",
      round: state.round + 1,
    },
  };
}

export function completeReview(
  state: ReviewLoopState,
  reason: "max_rounds",
): ReviewLoopState {
  requireActive(state);
  if (state.phase !== "reviewing") {
    throw new Error("A review completion requires a reviewing phase");
  }
  return {
    ...state,
    phase: "completed",
    completionReason: reason,
  };
}

export function stopLoop(
  state: ReviewLoopState,
  stopReason: ReviewLoopStopReason,
): ReviewLoopState {
  requireActive(state);
  return {
    ...state,
    phase: "stopped",
    stopReason,
  };
}
