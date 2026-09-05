import { join } from "node:path";
import {
  AssistantMessageComponent,
  CONFIG_DIR_NAME,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  completeReview,
  createIdleState,
  enterFixing,
  finishFix,
  isReviewLoopActive,
  pauseLoop,
  resumeLoop,
  startLoop,
  stopLoop,
  type ReviewLoopState,
} from "../src/reviewLoopState";
import {
  DEFAULT_REVIEW_PROMPT,
  loadReviewPrompt,
} from "../src/reviewLoopConfig";

const COMMAND_NAME = "review-loop";
const RESUME_PHRASES = [
  "go on",
  "continue",
  "keep going",
  "続けて",
  "続行",
];
const PAUSE_HINT = "Send go on or run /review-loop resume to continue.";
const ENTRY_TYPE = "pi-review-loop-state";
const FINAL_REVIEW_RESULT_ENTRY_TYPE = "pi-review-loop-result";
const STATUS_KEY = "pi-review-loop";
const CONFIG_FILE_NAME = "review-loop.json";
const HASH_CONCURRENCY = 8;
const GIT_COMMAND_TIMEOUT_MS = 5_000;
const FINGERPRINT_DEADLINE_MS = 30_000;
const COMPACT_OUTPUT_PROMPT =
  "Keep the response concise. Do not include full diffs or full files. Do not summarize command results; when needed, include relevant command output verbatim. Omit unrelated or excessively large logs.";
const FIX_PROMPT = [
  "fix them",
  "Apply only safe, actionable fixes from the preceding review.",
  "Leave findings that require a user decision unchanged and mention them in your response.",
  COMPACT_OUTPUT_PROMPT,
].join(" ");

function parseReviewLoopArguments(argument: string): {
  maxRounds?: number;
  reviewPrompt?: string;
} {
  const match = argument.match(/^(\d+)(?:\s+(.+))?$/);
  if (match) {
    return {
      maxRounds: Number(match[1]),
      ...(match[2] ? { reviewPrompt: match[2].trim() } : {}),
    };
  }
  return argument ? { reviewPrompt: argument } : {};
}

function buildReviewPrompt(
  reviewPrompt: string,
  additionalInstructions: string | undefined,
): string {
  return [
    reviewPrompt,
    ...(additionalInstructions
      ? [`Additional review instructions: ${additionalInstructions}`]
      : []),
  ].join(" ");
}

function isResumeInput(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return RESUME_PHRASES.includes(normalized);
}

interface PersistedReviewLoopState {
  phase: ReviewLoopState["phase"];
  round: number;
  maxRounds: number;
  pausedFrom?: ReviewLoopState["pausedFrom"];
  duration?: string;
  pendingReview?: string;
  completionReason?: ReviewLoopState["completionReason"];
  stopReason?: ReviewLoopState["stopReason"];
}

interface PendingPrompt {
  content: string;
  expandPromptTemplates: boolean;
}

interface FinalReviewResultEntry {
  content: string;
}

function createAssistantMessage(
  content: string,
): Parameters<AssistantMessageComponent["updateContent"]>[0] {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "review-loop",
    provider: "review-loop",
    model: "review-loop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toPersistedState(
  state: ReviewLoopState,
  duration?: string,
  pendingReview?: string,
): PersistedReviewLoopState {
  return {
    phase: state.phase,
    round: state.round,
    maxRounds: state.maxRounds,
    ...(state.pausedFrom ? { pausedFrom: state.pausedFrom } : {}),
    ...(duration ? { duration } : {}),
    ...(pendingReview ? { pendingReview } : {}),
    ...(state.completionReason
      ? { completionReason: state.completionReason }
      : {}),
    ...(state.stopReason ? { stopReason: state.stopReason } : {}),
  };
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const formatUnit = (
    value: number,
    singular: string,
    plural: string,
  ): string => `${value} ${value === 1 ? singular : plural}`;

  if (hours > 0) {
    return [
      formatUnit(hours, "hour", "hours"),
      ...(minutes > 0 ? [formatUnit(minutes, "min", "mins")] : []),
    ].join(" ");
  }
  if (minutes > 0) return formatUnit(minutes, "min", "mins");
  return formatUnit(seconds, "sec", "secs");
}

function statusText(state: ReviewLoopState): string | undefined {
  if (state.phase === "idle") return undefined;
  if (state.phase === "reviewing")
    return `loop ${state.round}/${state.maxRounds} · reviewing`;
  if (state.phase === "fixing")
    return `loop ${state.round}/${state.maxRounds} · fixing`;
  if (state.phase === "paused")
    return `paused ${state.round}/${state.maxRounds} · ${state.pausedFrom ?? "unknown"}`;
  if (state.phase === "completed") return undefined;
  return `stopped: ${state.stopReason ?? "unknown"}`;
}

function extractMessageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant") return "";
  if (typeof record.content === "string") return record.content.trim();
  if (!Array.isArray(record.content)) return "";

  return record.content
    .map((part: unknown) => {
      if (typeof part !== "object" || part === null) return "";
      const textPart = part as { type?: unknown; text?: unknown };
      return textPart.type === "text" && typeof textPart.text === "string"
        ? textPart.text
        : "";
    })
    .join("")
    .trim();
}

function extractAssistantText(messages: readonly unknown[]): string {
  return messages
    .map((message) => extractMessageText(message))
    .filter((text): text is string => Boolean(text))
    .join("\n\n")
    .trim();
}

function hasAssistantError(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    if (typeof message !== "object" || message === null) return false;
    const record = message as { role?: unknown; stopReason?: unknown };
    return record.role === "assistant" && record.stopReason === "error";
  });
}

// 最後の assistant メッセージが abort なら、そのターンは結果を出せずに中断された
function wasTurnAborted(messages: readonly unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; stopReason?: unknown };
    if (record.role !== "assistant") continue;
    return record.stopReason === "aborted";
  }
  return false;
}

export default function reviewLoopExtension(pi: ExtensionAPI): void {
  let state = createIdleState();
  let pendingPrompt: PendingPrompt | undefined;
  let reviewInstructions: string | undefined;
  let configuredReviewPrompt = DEFAULT_REVIEW_PROMPT;
  let loopStartedAt: number | undefined;
  let beforeFixFingerprint: string | undefined;
  let fixChangedByTool = false;
  let latestReviewText: string | undefined;
  let latestFixText: string | undefined;
  let agentEndWithoutText = false;

  pi.registerEntryRenderer<FinalReviewResultEntry>(
    FINAL_REVIEW_RESULT_ENTRY_TYPE,
    (entry) => {
      const content = entry.data?.content;
      if (!content) return undefined;
      return new AssistantMessageComponent(createAssistantMessage(content));
    },
  );

  async function runGit(
    args: string[],
    cwd: string,
    timeout: number,
  ): Promise<string | undefined> {
    const result = await pi.exec("git", args, { cwd, timeout });
    // タイムアウトで kill されたコマンドは code 0 と切断済み出力を返すため信頼しない
    return result.code === 0 && !result.killed ? result.stdout : undefined;
  }

  async function getWorkingTreeFingerprint(
    cwd: string,
  ): Promise<string | undefined> {
    // フィンガープリント全体の所要時間には上限を置き、超過時はツール検出へ退避させる
    const deadline = Date.now() + FINGERPRINT_DEADLINE_MS;
    const gitWithinDeadline = (args: string[]): Promise<string | undefined> => {
      const timeout = Math.min(GIT_COMMAND_TIMEOUT_MS, deadline - Date.now());
      if (timeout <= 0) return Promise.resolve(undefined);
      return runGit(args, cwd, timeout);
    };

    const [status, diff, cachedDiff, untracked] = await Promise.all([
      gitWithinDeadline(["status", "--porcelain=v1", "--untracked-files=all"]),
      gitWithinDeadline(["diff", "--no-ext-diff", "--binary", "--"]),
      gitWithinDeadline(["diff", "--cached", "--no-ext-diff", "--binary", "--"]),
      gitWithinDeadline(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    if (
      status === undefined ||
      diff === undefined ||
      cachedDiff === undefined ||
      untracked === undefined
    ) {
      return undefined;
    }

    const paths = untracked.split("\0").filter(Boolean);
    const hashes: Array<string | undefined> = [];
    for (let index = 0; index < paths.length; index += HASH_CONCURRENCY) {
      const batch = paths.slice(index, index + HASH_CONCURRENCY);
      hashes.push(
        ...(await Promise.all(
          batch.map(async (path) => {
            const timeout = Math.min(
              GIT_COMMAND_TIMEOUT_MS,
              deadline - Date.now(),
            );
            if (timeout <= 0) return undefined;
            const result = await pi.exec("git", ["hash-object", "--", path], {
              cwd,
              timeout,
            });
            return result.code === 0 && !result.killed
              ? `${path}\0${result.stdout}`
              : undefined;
          }),
        )),
      );
    }
    if (hashes.some((hash) => hash === undefined)) return undefined;

    return JSON.stringify({
      status,
      diff,
      cachedDiff,
      untracked: hashes,
    });
  }

  function resetRunData(): void {
    pendingPrompt = undefined;
    reviewInstructions = undefined;
    beforeFixFingerprint = undefined;
    fixChangedByTool = false;
    latestReviewText = undefined;
    latestFixText = undefined;
    agentEndWithoutText = false;
  }

  function getPendingReviewText(): string | undefined {
    const sections = [
      latestReviewText ? `Review result:\n${latestReviewText}` : undefined,
      latestFixText ? `Fix response:\n${latestFixText}` : undefined,
    ].filter((section): section is string => Boolean(section));
    const text = sections.join("\n\n").trim();
    return text || undefined;
  }

  function loadConfiguredReviewPrompt(ctx: ExtensionContext): void {
    const configPaths = [join(getAgentDir(), CONFIG_FILE_NAME)];
    if (ctx.isProjectTrusted()) {
      configPaths.push(join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME));
    }
    const config = loadReviewPrompt(configPaths);
    configuredReviewPrompt = config.prompt;
    for (const warning of config.warnings) {
      ctx.ui.notify(warning, "warning");
    }
  }

  function persistAndDisplay(
    nextState: ReviewLoopState,
    ctx: ExtensionContext,
    pendingReview?: string,
  ): void {
    const isTerminal =
      nextState.phase === "completed" || nextState.phase === "stopped";
    const duration =
      nextState.phase === "completed" && loopStartedAt !== undefined
        ? formatDuration(Date.now() - loopStartedAt)
        : undefined;
    state = nextState;
    ctx.ui.setStatus(STATUS_KEY, statusText(state));
    pi.appendEntry<PersistedReviewLoopState>(
      ENTRY_TYPE,
      toPersistedState(state, duration, pendingReview),
    );
    if (state.phase === "completed" && duration) {
      const loopLabel = `${state.round} ${state.round === 1 ? "loop" : "loops"}`;
      ctx.ui.notify(
        `Review loop completed after ${loopLabel} in ${duration}.`,
        "warning",
      );
    }
    if (isTerminal && pendingReview) {
      pi.appendEntry<FinalReviewResultEntry>(
        FINAL_REVIEW_RESULT_ENTRY_TYPE,
        { content: `Final review result:\n${pendingReview}` },
      );
    }
    if (isTerminal) loopStartedAt = undefined;
  }

  function stopForProtocolError(ctx: ExtensionContext, message: string): void {
    const wasActive = isReviewLoopActive(state);
    resetRunData();
    if (wasActive) {
      persistAndDisplay(stopLoop(state, "protocol_error"), ctx);
    } else {
      loopStartedAt = undefined;
    }
    ctx.ui.notify(message, "error");
  }

  async function startPendingPrompt(
    prompt: PendingPrompt,
    ctx: ExtensionContext,
  ): Promise<void> {
    try {
      await pi.sendUserMessage(
        prompt.content,
        prompt.expandPromptTemplates
          ? { expandPromptTemplates: true }
          : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stopForProtocolError(
        ctx,
        `Could not queue the next review-loop step: ${message}`,
      );
    }
  }

  function buildStepPrompt(phase: "reviewing" | "fixing"): string {
    return phase === "reviewing"
      ? buildReviewPrompt(configuredReviewPrompt, reviewInstructions)
      : FIX_PROMPT;
  }

  function pauseForAbort(ctx: ExtensionContext): void {
    persistAndDisplay(pauseLoop(state), ctx);
    ctx.ui.notify(`Review loop paused. ${PAUSE_HINT}`, "warning");
  }

  async function resumeLoopFromPause(
    ctx: ExtensionContext,
  ): Promise<void> {
    const resumed = resumeLoop(state);
    persistAndDisplay(resumed, ctx);
    ctx.ui.notify("Review loop resumed.", "info");
    await startPendingPrompt(
      {
        content: buildStepPrompt(resumed.phase),
        expandPromptTemplates: resumed.phase === "reviewing",
      },
      ctx,
    );
  }

  pi.registerCommand(COMMAND_NAME, {
    description:
      "Review and automatically fix the current worktree until clean.",
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument === "stop") {
        if (!isReviewLoopActive(state) && state.phase !== "paused") {
          ctx.ui.notify("Review loop is not running.", "info");
          return;
        }
        // paused 中は走っているターンがないため abort は不要
        if (isReviewLoopActive(state)) ctx.abort();
        resetRunData();
        persistAndDisplay(stopLoop(state, "abort"), ctx);
        ctx.ui.notify("Review loop stopped.", "info");
        return;
      }

      if (argument === "resume") {
        if (state.phase !== "paused") {
          ctx.ui.notify("Review loop is not paused.", "info");
          return;
        }
        await resumeLoopFromPause(ctx);
        return;
      }

      if (isReviewLoopActive(state)) {
        ctx.ui.notify("Review loop is already running.", "warning");
        return;
      }
      if (state.phase === "paused") {
        ctx.ui.notify(`Review loop is paused. ${PAUSE_HINT}`, "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Agent is busy. Start the review loop after it becomes idle.",
          "warning",
        );
        return;
      }

      loadConfiguredReviewPrompt(ctx);
      const { maxRounds, reviewPrompt } = parseReviewLoopArguments(argument);
      try {
        state = startLoop(maxRounds);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "warning");
        return;
      }
      loopStartedAt = Date.now();
      resetRunData();
      reviewInstructions = reviewPrompt;
      persistAndDisplay(state, ctx);
      try {
        await pi.sendUserMessage(
          buildReviewPrompt(configuredReviewPrompt, reviewInstructions),
          { expandPromptTemplates: true },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stopForProtocolError(
          ctx,
          `Could not start the review loop: ${message}`,
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state = createIdleState();
    resetRunData();
    configuredReviewPrompt = DEFAULT_REVIEW_PROMPT;
    loopStartedAt = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("tool_execution_end", async (event) => {
    if (
      state.phase === "fixing" &&
      !event.isError &&
      (event.toolName === "edit" || event.toolName === "write")
    ) {
      fixChangedByTool = true;
    }
  });

  pi.on("input", async (event, ctx) => {
    // 拡張機能が送るプロンプト（source: "extension"）は対象外。
    if (event.source === "extension") return;

    if (state.phase === "paused") {
      // 再開フレーズなら消費してループを再開し、それ以外は停止して通常通り通過させる
      if (isResumeInput(event.text)) {
        await resumeLoopFromPause(ctx);
        return { action: "handled" };
      }
      resetRunData();
      persistAndDisplay(stopLoop(state, "abort"), ctx);
      ctx.ui.notify("Review loop stopped: user input received.", "warning");
      return;
    }

    // ユーザー自身が入力するとレビュー/修正の順序保証が破れるため停止する。
    if (!isReviewLoopActive(state)) return;
    resetRunData();
    persistAndDisplay(stopLoop(state, "abort"), ctx);
    ctx.ui.notify("Review loop stopped: user input received.", "warning");
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!isReviewLoopActive(state)) return;
    if (hasAssistantError(event.messages)) {
      agentEndWithoutText = true;
      return;
    }

    if (state.phase === "reviewing") {
      const reviewText = extractAssistantText(event.messages);
      if (!reviewText) {
        // テキストのない中断は再開可能なので protocol error にはしない
        if (wasTurnAborted(event.messages)) {
          pauseForAbort(ctx);
          return;
        }
        agentEndWithoutText = true;
        return;
      }
      agentEndWithoutText = false;
      latestReviewText = reviewText;
      if (state.round >= state.maxRounds) {
        persistAndDisplay(
          completeReview(state, "max_rounds"),
          ctx,
          getPendingReviewText(),
        );
        return;
      }

      try {
        beforeFixFingerprint = await getWorkingTreeFingerprint(ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stopForProtocolError(
          ctx,
          `Could not inspect the worktree before fixing: ${message}`,
        );
        return;
      }
      fixChangedByTool = false;
      persistAndDisplay(enterFixing(state), ctx);
      pendingPrompt = { content: FIX_PROMPT, expandPromptTemplates: false };
      return;
    }

    const fixText = extractAssistantText(event.messages);
    if (!fixText) {
      // テキストのない中断は再開可能なので protocol error にはしない
      if (wasTurnAborted(event.messages)) {
        pauseForAbort(ctx);
        return;
      }
      agentEndWithoutText = true;
      return;
    }
    agentEndWithoutText = false;
    latestFixText = fixText;
    let afterFixFingerprint: string | undefined;
    try {
      afterFixFingerprint = await getWorkingTreeFingerprint(ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stopForProtocolError(
        ctx,
        `Could not inspect the worktree after fixing: ${message}`,
      );
      return;
    }
    const changed =
      beforeFixFingerprint !== undefined && afterFixFingerprint !== undefined
        ? beforeFixFingerprint !== afterFixFingerprint
        : fixChangedByTool;
    beforeFixFingerprint = undefined;
    const transition = finishFix(state, changed);
    if (transition.next === "completed") {
      persistAndDisplay(
        transition.state,
        ctx,
        getPendingReviewText(),
      );
      return;
    }

    persistAndDisplay(transition.state, ctx);
    pendingPrompt = {
      content: buildReviewPrompt(configuredReviewPrompt, reviewInstructions),
      expandPromptTemplates: true,
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (pendingPrompt && isReviewLoopActive(state)) {
      const nextPrompt = pendingPrompt;
      pendingPrompt = undefined;
      await startPendingPrompt(nextPrompt, ctx);
      return;
    }
    if (isReviewLoopActive(state)) {
      stopForProtocolError(
        ctx,
        agentEndWithoutText
          ? "The agent ended without a review-loop result. The loop was stopped."
          : "The agent settled before the review loop reached the next step.",
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (isReviewLoopActive(state) || state.phase === "paused") {
      persistAndDisplay(stopLoop(state, "shutdown"), ctx);
    } else {
      loopStartedAt = undefined;
    }
    resetRunData();
    configuredReviewPrompt = DEFAULT_REVIEW_PROMPT;
  });
}
