import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ROUNDS,
  completeReview,
  createIdleState,
  enterFixing,
  finishFix,
  pauseLoop,
  resumeLoop,
  startLoop,
  stopLoop,
} from "../src/reviewLoopState";

describe("review loop state", () => {
  it("starts the first review at round one with a ten-round default limit", () => {
    expect(startLoop()).toEqual({
      phase: "reviewing",
      round: 1,
      maxRounds: 10,
    });
  });

  it("moves from a review to fixing and from changed fixes to the next review", () => {
    const reviewing = startLoop(3);
    const fixing = enterFixing(reviewing);
    const nextReview = finishFix(fixing, true);

    expect(fixing).toEqual({
      phase: "fixing",
      round: 1,
      maxRounds: 3,
    });
    expect(nextReview).toEqual({
      next: "review",
      state: {
        phase: "reviewing",
        round: 2,
        maxRounds: 3,
      },
    });
  });

  it("completes when a fix leaves the worktree unchanged", () => {
    expect(finishFix(enterFixing(startLoop()), false)).toEqual({
      next: "completed",
      state: {
        phase: "completed",
        round: 1,
        maxRounds: DEFAULT_MAX_ROUNDS,
        completionReason: "no_changes",
      },
    });
  });

  it("completes the final review at the round limit", () => {
    expect(completeReview(startLoop(1), "max_rounds")).toEqual({
      phase: "completed",
      round: 1,
      maxRounds: 1,
      completionReason: "max_rounds",
    });
  });

  it("supports explicit aborts only while active", () => {
    expect(stopLoop(startLoop(), "abort")).toMatchObject({
      phase: "stopped",
      stopReason: "abort",
    });
    expect(() =>
      stopLoop({ phase: "completed", round: 1, maxRounds: 10 }, "abort"),
    ).toThrow("active");
  });

  it("pauses an active loop and remembers the interrupted phase", () => {
    expect(pauseLoop(startLoop(3))).toEqual({
      phase: "paused",
      round: 1,
      maxRounds: 3,
      pausedFrom: "reviewing",
    });
    expect(pauseLoop(enterFixing(startLoop(3)))).toEqual({
      phase: "paused",
      round: 1,
      maxRounds: 3,
      pausedFrom: "fixing",
    });
  });

  it("resumes a paused loop into the interrupted phase without extra fields", () => {
    expect(resumeLoop(pauseLoop(startLoop(3)))).toEqual({
      phase: "reviewing",
      round: 1,
      maxRounds: 3,
    });
    expect(resumeLoop(pauseLoop(enterFixing(startLoop(3))))).toEqual({
      phase: "fixing",
      round: 1,
      maxRounds: 3,
    });
  });

  it("rejects pausing inactive loops and resuming unparsed states", () => {
    expect(() => pauseLoop(createIdleState())).toThrow();
    expect(() => pauseLoop(stopLoop(startLoop(), "abort"))).toThrow();
    expect(() => resumeLoop(startLoop())).toThrow();
    expect(() =>
      resumeLoop({ phase: "paused", round: 1, maxRounds: 10 }),
    ).toThrow();
  });

  it("stops a paused loop and drops the paused phase marker", () => {
    expect(stopLoop(pauseLoop(startLoop()), "shutdown")).toEqual({
      phase: "stopped",
      round: 1,
      maxRounds: DEFAULT_MAX_ROUNDS,
      stopReason: "shutdown",
    });
  });

  it("rejects invalid limits and invalid phase transitions", () => {
    expect(() => startLoop(0)).toThrow("between 1 and 10");
    expect(() => startLoop(11)).toThrow("between 1 and 10");
    expect(() =>
      enterFixing({ phase: "fixing", round: 1, maxRounds: 10 }),
    ).toThrow("reviewing");
    expect(() => finishFix(startLoop(), true)).toThrow("fixing");
    expect(() =>
      completeReview(
        { phase: "fixing", round: 1, maxRounds: 10 },
        "max_rounds",
      ),
    ).toThrow("reviewing");
  });
});
