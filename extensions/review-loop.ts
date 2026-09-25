import { join } from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import {
  AssistantMessageComponent,
  CONFIG_DIR_NAME,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
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
import {
  DECISION_ITEMS_PROMPT,
  parseDecisionItems,
  type ReviewDecisionPreviewItem,
} from "../src/reviewDecisionItems";
import {
  ReviewDecisionPreviewComponent,
  type ReviewDecisionPreviewResult,
} from "./review-decision-preview";

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
// 決定 UI はループ完了時のみ一時的に無効化している。UI コードは残しているため、
// true に戻せば完了時に決定 UI を開く元の挙動へ戻る。
const DECISION_UI_ON_COMPLETION = false;
// レビュー/修正プロンプトへの判断必要 finding を json ブロックで出力させる指示は
// 一時的に無効化している。true に戻せばエージェントが決定項目を出力する元の挙動へ戻る。
const DECISION_ITEMS_PROMPT_ENABLED = false;
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
  ...(DECISION_ITEMS_PROMPT_ENABLED ? [DECISION_ITEMS_PROMPT] : []),
  COMPACT_OUTPUT_PROMPT,
].join(" ");

// ctx.shutdown() はフラグを立てるだけで agent_settled イベント発火時に処理される。
// エージェントが待機中の決定画面からは発火しないため、pi 自身の SIGTERM
// ハンドラ経由で即座に graceful 終了する（session_shutdown と端末復元もされる）。
function requestImmediateShutdown(): void {
  process.kill(process.pid, "SIGTERM");
}

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

// ユーザー決定に基づく修正依頼プロンプト（エージェントには英語で送る）
function buildDecisionFixPrompt(
  items: readonly ReviewDecisionPreviewItem[],
  result: ReviewDecisionPreviewResult,
): string {
  const decisionLines = result.decisions.map((decision) => {
    const item = items.find((entry) => entry.id === decision.id);
    return `- ${item?.title ?? decision.id}: ${decision.value}`;
  });
  return [
    "The review loop left the following findings pending a user decision. The user has now chosen an action for each one:",
    ...decisionLines,
    "Apply the chosen action for each finding. Apply only safe, actionable fixes.",
    "If a chosen action defers or declines a fix, leave that code unchanged and mention it in your response.",
    COMPACT_OUTPUT_PROMPT,
  ].join("\n");
}

function buildReviewPrompt(
  reviewPrompt: string,
  instructions: string | undefined,
): string {
  return [
    instructions
      ? `/skill:code-review ${instructions} Do not modify files during this review.`
      : reviewPrompt,
    // 設定されたプロンプトが何であっても判断必要 finding は JSON で出力させる（一時的に無効化中）
    ...(DECISION_ITEMS_PROMPT_ENABLED ? [DECISION_ITEMS_PROMPT] : []),
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

function formatFinalReviewResult(pendingReview: string): string {
  return [
    "Review loop completed.",
    "",
    "User decisions required",
    "",
    "Review the following findings and choose an action for each one.",
    "",
    "Final review result:",
    pendingReview,
  ].join("\n");
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
  let handledSessionStop = false;
  let commandContext: ExtensionCommandContext | undefined;

  const supportsEntryRendering = typeof pi.registerEntryRenderer === "function";
  if (supportsEntryRendering) {
    pi.registerEntryRenderer<FinalReviewResultEntry>(
      FINAL_REVIEW_RESULT_ENTRY_TYPE,
      (entry) => {
        const content = entry.data?.content;
        if (!content) return undefined;
        return new AssistantMessageComponent(createAssistantMessage(content));
      },
    );
  } else {
    // OMP renders custom messages, but not custom persistence entries.
    pi.registerMessageRenderer<FinalReviewResultEntry>(
      FINAL_REVIEW_RESULT_ENTRY_TYPE,
      (message) => {
        const content = message.details?.content;
        if (!content) return undefined;
        return new AssistantMessageComponent(createAssistantMessage(content));
      },
    );
    pi.on("context", (event) => ({
      messages: event.messages.filter(
        (message) =>
          message.role !== "custom" ||
          message.customType !== FINAL_REVIEW_RESULT_ENTRY_TYPE,
      ),
    }));
  }

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
    if (isTerminal) loopStartedAt = undefined;
  }

  function appendFinalReviewResult(
    pendingReview: string,
    ctx: ExtensionContext,
  ): void {
    const data = { content: formatFinalReviewResult(pendingReview) };
    if (supportsEntryRendering) {
      pi.appendEntry<FinalReviewResultEntry>(FINAL_REVIEW_RESULT_ENTRY_TYPE, data);
    } else {
      const command = commandContext;
      if (!command) {
        // 防御的: ループはコマンドでしか有効化されないため通常は到達しない
        ctx.ui.notify(
          "Could not display the final review result: the command context is unavailable.",
          "error",
        );
        return;
      }
      // During OMP session_stop, even triggerTurn:false queues a streaming
      // message and causes another model call. Publish only after it is idle.
      // Do not await here: the current lifecycle handler must finish first.
      void command.waitForIdle().then(async () => {
        // waitForIdle observes the agent; let OMP finish the surrounding
        // session-stop maintenance before publishing a display-only message.
        await nextEventLoopTurn();
        pi.sendMessage<FinalReviewResultEntry>({
          customType: FINAL_REVIEW_RESULT_ENTRY_TYPE,
          content: data.content,
          display: true,
          details: data,
        }, { triggerTurn: false, deliverAs: "nextTurn" });
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        command.ui.notify(`Could not display the final review result: ${message}`, "error");
      });
    }
  }

  // ループ完了時にユーザー判断が必要な finding があれば決定 UI を表示し（TUI のみ、
  // DECISION_UI_ON_COMPLETION で一時的に無効化中）、全項目が決定されたら
  // 決定に基づいて修正を自動開始する
  async function completeLoop(
    nextState: ReviewLoopState,
    ctx: ExtensionContext,
  ): Promise<void> {
    const pendingReview = getPendingReviewText();
    persistAndDisplay(nextState, ctx, pendingReview);
    if (!pendingReview) return;

    const items = parseDecisionItems(pendingReview);
    if (
      !DECISION_UI_ON_COMPLETION ||
      !items ||
      !ctx.hasUI ||
      ctx.mode !== "tui"
    ) {
      appendFinalReviewResult(pendingReview, ctx);
      return;
    }

    let result: ReviewDecisionPreviewResult;
    try {
      result = await ctx.ui.custom<ReviewDecisionPreviewResult>(
        (tui, theme, _keybindings, done) =>
          new ReviewDecisionPreviewComponent(
            items,
            tui,
            theme,
            done,
            // 単発 Ctrl+C で即座に graceful 終了する
            requestImmediateShutdown,
          ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendFinalReviewResult(pendingReview, ctx);
      ctx.ui.notify(`Could not open the decision preview: ${message}`, "error");
      return;
    }

    if (result.cancelled || result.decisions.length < items.length) {
      appendFinalReviewResult(pendingReview, ctx);
      ctx.ui.notify(
        "Decision preview closed. The findings are listed in the final review result.",
        "info",
      );
      return;
    }

    // 全項目が決定済み: 決定に基づいて修正を自動開始する
    ctx.ui.notify("All findings decided. Starting fixes.", "info");
    try {
      await pi.sendUserMessage(buildDecisionFixPrompt(items, result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not start fixing: ${message}`, "error");
    }
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
      commandContext = ctx;
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

  async function handleAgentResult(
    event: { messages: readonly unknown[] },
    ctx: ExtensionContext,
  ): Promise<void> {
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
        await completeLoop(completeReview(state, "max_rounds"), ctx);
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
      await completeLoop(transition.state, ctx);
      return;
    }

    persistAndDisplay(transition.state, ctx);
    pendingPrompt = {
      content: buildReviewPrompt(configuredReviewPrompt, reviewInstructions),
      expandPromptTemplates: true,
    };
  }

  pi.on("agent_start", () => {
    handledSessionStop = false;
  });
  pi.on("agent_end", async (event, ctx) => {
    if (handledSessionStop || ("willContinue" in event && event.willContinue)) return;
    await handleAgentResult(event, ctx);
  });

  // OMP emits session_stop BEFORE agent_end and accepts a blocking continuation.
  // Pi's published ExtensionAPI does not declare this OMP lifecycle event.
  const ompEvents = pi as unknown as {
    on(
      event: "session_stop",
      handler: (
        event: { messages: readonly unknown[]; last_assistant_message?: unknown },
        ctx: ExtensionContext,
      ) => Promise<{ decision: "block"; reason: string } | undefined>,
    ): void;
  };
  ompEvents.on("session_stop", async (event, ctx) => {
    // 同一ランの二重発火防止: 結果の再処理と継続の二重許可を防ぐ
    if (handledSessionStop) return undefined;
    handledSessionStop = true;
    await handleAgentResult({
      messages: event.last_assistant_message
        ? [event.last_assistant_message]
        : event.messages,
    }, ctx);
    if (!isReviewLoopActive(state)) return undefined;
    if (!pendingPrompt) {
      // エラーや結果なしのランはリトライの可能性があるため、
      // Pi の agent_end パスと同様に停止の判定を agent_settled に委ねる
      if (agentEndWithoutText) return undefined;
      stopForProtocolError(ctx, "The agent ended without a review-loop result. The loop was stopped.");
      return undefined;
    }
    const nextPrompt = pendingPrompt;
    pendingPrompt = undefined;
    return { decision: "block", reason: nextPrompt.content };
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
