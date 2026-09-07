import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssistantMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import reviewLoopExtension from "../extensions/review-loop";
import { DEFAULT_REVIEW_PROMPT } from "../src/reviewLoopConfig";

type FakeContext = {
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    custom: ReturnType<typeof vi.fn>;
  };
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  isIdle: ReturnType<typeof vi.fn>;
  waitForIdle: () => Promise<void>;
  abort: ReturnType<typeof vi.fn>;
  cwd: string;
  isProjectTrusted: ReturnType<typeof vi.fn>;
  sessionManager: {
    getEntries: () => unknown[];
  };
};

type EventHandler = (
  event: unknown,
  context: FakeContext,
) => Promise<unknown> | unknown;
type CommandHandler = (args: string, context: FakeContext) => Promise<void>;

class FakePi {
  readonly events = new Map<string, EventHandler>();
  readonly commands = new Map<string, { handler: CommandHandler }>();
  readonly sentMessages: Array<{
    content: string;
    options?: Record<string, unknown>;
  }> = [];
  readonly entries: Array<{ type: string; data: unknown }> = [];
  readonly entryRenderers = new Map<string, (...args: unknown[]) => unknown>();
  readonly sendUserMessage = vi.fn(
    (content: string, options?: Record<string, unknown>) => {
      this.sentMessages.push({ content, options });
    },
  );
  readonly exec = vi.fn(
    async (_command: string, _args: string[], _options?: unknown) => ({
      stdout: "",
      stderr: "",
      code: 128,
      killed: false,
    }),
  );

  on(event: string, handler: EventHandler): void {
    this.events.set(event, handler);
  }

  registerCommand(name: string, options: { handler: CommandHandler }): void {
    this.commands.set(name, options);
  }

  appendEntry(type: string, data: unknown): void {
    this.entries.push({ type, data });
  }

  registerEntryRenderer(
    type: string,
    renderer: (...args: unknown[]) => unknown,
  ): void {
    this.entryRenderers.set(type, renderer);
  }

  getActiveTools(): string[] {
    return ["read", "bash", "edit", "write"];
  }
}

function createContext(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn(async () => ({ cancelled: true, decisions: [] })),
    },
    mode: "tui",
    hasUI: true,
    isIdle: vi.fn(() => true),
    waitForIdle: async () => {},
    abort: vi.fn(),
    cwd: "/tmp/pi-review-loop-test",
    isProjectTrusted: vi.fn(() => true),
    sessionManager: {
      getEntries: () => [],
    },
    ...overrides,
  };
}

function installExtension(): { pi: FakePi; context: FakeContext } {
  const pi = new FakePi();
  reviewLoopExtension(pi as unknown as ExtensionAPI);
  return { pi, context: createContext() };
}

function lastStateEntry(
  pi: FakePi,
): { type: string; data: unknown } | undefined {
  for (let index = pi.entries.length - 1; index >= 0; index -= 1) {
    const entry = pi.entries[index];
    if (entry.type === "pi-review-loop-state") return entry;
  }
  return undefined;
}

async function emit(
  pi: FakePi,
  event: string,
  context: FakeContext,
  payload: unknown = {},
): Promise<unknown> {
  const handler = pi.events.get(event);
  if (!handler) return undefined;
  return await handler(payload, context);
}

function assistantEvent(text: string): { messages: unknown[] } {
  return {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function abortedEvent(): { messages: unknown[] } {
  return {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "interrupted mid-turn" }],
        stopReason: "aborted",
      },
    ],
  };
}

const DECISION_JSON = [
  "```json",
  "[",
  "  {",
  '    "id": "admin-list-overflow",',
  '    "title": "Long user names overflow the admin list",',
  '    "category": "ui",',
  '    "priority": "low",',
  '    "recommendation": "Postpone is acceptable.",',
  '    "impact": "Only the admin display is affected.",',
  '    "criteria": ["No security impact."],',
  '    "actions": ["Fix in this release", "Postpone"]',
  "  }",
  "]",
  "```",
].join("\n");

async function runLoop(
  pi: FakePi,
  context: FakeContext,
  args = "",
): Promise<void> {
  const command = pi.commands.get("review-loop");
  if (!command) throw new Error("review-loop command was not registered");
  await command.handler(args, context);
}

function toolEnd(toolName: string, isError = false): unknown {
  return {
    toolCallId: "tool-call",
    toolName,
    result: {},
    isError,
  };
}

describe("review loop extension", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("shows the final result without entry rendering and excludes only that result from model context", async () => {
    const pi = new FakePi();
    type ResultMessage = {
      customType: string;
      content: string;
      display: boolean;
      details: { content: string };
    };
    type ResultRenderer = (message: ResultMessage) => AssistantMessageComponent | undefined;
    const renderers = new Map<string, ResultRenderer>();
    const messages: ResultMessage[] = [];
    Object.defineProperty(pi, "registerEntryRenderer", { value: undefined });
    Object.assign(pi, {
      registerMessageRenderer: (type: string, renderer: ResultRenderer) =>
        renderers.set(type, renderer),
      sendMessage: (message: ResultMessage, options: unknown) => {
        expect(options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
        messages.push(message);
      },
    });
    reviewLoopExtension(pi as unknown as ExtensionAPI);
    let settle!: () => void;
    const idle = new Promise<void>((resolve) => { settle = resolve; });
    const context = createContext({ waitForIdle: () => idle });

    await runLoop(pi, context, "1");
    await emit(pi, "agent_end", context, assistantEvent("Authorization needs a user decision."));

    expect(lastStateEntry(pi)).toMatchObject({ data: { phase: "completed" } });
    expect(messages).toEqual([]);
    settle();
    await idle;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(messages).toEqual([
      expect.objectContaining({
        customType: "pi-review-loop-result",
        display: true,
        content: expect.stringContaining("Authorization needs a user decision."),
      }),
    ]);
    const renderer = renderers.get("pi-review-loop-result");
    if (!renderer) throw new Error("result renderer was not registered");
    const component = renderer(messages[0]);
    if (!component) throw new Error("result did not render");
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("Authorization needs a user decision.");
    expect(pi.sentMessages).toHaveLength(1);

    const user = { role: "user", content: "Continue" };
    const unrelated = { role: "custom", customType: "another-extension", content: "Keep this" };
    const result = { role: "custom", ...messages[0] };
    expect(await emit(pi, "context", context, { messages: [user, result, unrelated] }))
      .toEqual({ messages: [user, unrelated] });
    expect(await emit(pi, "context", context, { messages: [user, unrelated] }))
      .toEqual({ messages: [user, unrelated] });
  });

  it("continues review and fixing through OMP session_stop without starting another user turn", async () => {
    const { pi, context } = installExtension();
    await runLoop(pi, context);
    await emit(pi, "agent_start", context);
    const review = assistantEvent("Authorization needs a user decision.");
    expect(await emit(pi, "session_stop", context, review)).toEqual({
      continue: true,
      additionalContext: expect.stringContaining("fix them"),
    });
    // OMP notifies agent_end only after session_stop: do not treat the same
    // review as a fix result and finish before the actual fix has run.
    await emit(pi, "agent_end", context, review);
    expect(lastStateEntry(pi)).toMatchObject({ data: { phase: "fixing" } });
    await emit(pi, "agent_start", context);
    const fix = assistantEvent("No safe changes can be made.");
    expect(await emit(pi, "session_stop", context, {
      messages: [...review.messages, ...fix.messages],
      last_assistant_message: fix.messages[0],
    })).toBeUndefined();
    await emit(pi, "agent_end", context, fix);
    expect(lastStateEntry(pi)).toMatchObject({
      data: { phase: "completed", completionReason: "no_changes" },
    });
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("waits for a retry run after a provider error at OMP session_stop", async () => {
    const { pi, context } = installExtension();
    await runLoop(pi, context);
    await emit(pi, "agent_start", context);
    const errorEvent = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "rate limited" }],
          stopReason: "error",
        },
      ],
    };
    expect(await emit(pi, "session_stop", context, errorEvent)).toBeUndefined();
    // Pi's agent_end path survives an error run because a retry may follow;
    // the session_stop path must wait for agent_settled instead of stopping.
    expect(lastStateEntry(pi)).toMatchObject({ data: { phase: "reviewing" } });

    await emit(pi, "agent_start", context);
    const review = assistantEvent("Authorization needs a user decision.");
    expect(await emit(pi, "session_stop", context, review)).toEqual({
      continue: true,
      additionalContext: expect.stringContaining("fix them"),
    });
  });

  it("stops with a protocol error when the OMP error run is not retried", async () => {
    const { pi, context } = installExtension();
    await runLoop(pi, context);
    await emit(pi, "agent_start", context);
    await emit(pi, "session_stop", context, {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "rate limited" }],
          stopReason: "error",
        },
      ],
    });

    // The stop happens on settle, exactly like Pi's un-retried error path.
    await emit(pi, "agent_settled", context);

    expect(lastStateEntry(pi)).toMatchObject({
      data: { phase: "stopped", stopReason: "protocol_error" },
    });
    expect(context.ui.notify).toHaveBeenCalledWith(
      "The agent ended without a review-loop result. The loop was stopped.",
      "error",
    );
  });

  it("ignores a duplicate OMP session_stop for the same run", async () => {
    const { pi, context } = installExtension();
    await runLoop(pi, context);
    await emit(pi, "agent_start", context);
    const review = assistantEvent("Authorization needs a user decision.");
    expect(await emit(pi, "session_stop", context, review)).toEqual({
      continue: true,
      additionalContext: expect.stringContaining("fix them"),
    });

    // A second fire for the same run must not reprocess the result or
    // grant another continuation.
    expect(await emit(pi, "session_stop", context, review)).toBeUndefined();
    expect(lastStateEntry(pi)).toMatchObject({ data: { phase: "fixing" } });
    expect(
      pi.entries.filter((entry) => entry.type === "pi-review-loop-result"),
    ).toHaveLength(0);
  });

  it("stops clearly when OMP does not re-fire agent_start for a continued run", async () => {
    const { pi, context } = installExtension();
    await runLoop(pi, context);
    await emit(pi, "agent_start", context);
    const review = assistantEvent("Authorization needs a user decision.");
    expect(await emit(pi, "session_stop", context, review)).toEqual({
      continue: true,
      additionalContext: expect.stringContaining("fix them"),
    });

    // If the host does not re-fire agent_start for the continued run, the
    // duplicate-fire guard must keep the second session_stop from
    // reprocessing the stale result; the loop then stops at settle instead
    // of hanging or publishing a duplicate final result.
    const fix = assistantEvent("No safe changes can be made.");
    expect(await emit(pi, "session_stop", context, fix)).toBeUndefined();
    await emit(pi, "agent_settled", context);

    expect(lastStateEntry(pi)).toMatchObject({
      data: { phase: "stopped", stopReason: "protocol_error" },
    });
    expect(
      pi.entries.filter((entry) => entry.type === "pi-review-loop-result"),
    ).toHaveLength(0);
  });

  it("skips an OMP agent_end that will continue via session_stop", async () => {
    const { pi, context } = installExtension();
    await runLoop(pi, context);
    const review = assistantEvent("Authorization needs a user decision.");
    await emit(pi, "agent_end", context, { ...review, willContinue: true });

    // The result must not be consumed before session_stop is consulted.
    expect(lastStateEntry(pi)).toMatchObject({ data: { phase: "reviewing" } });

    expect(await emit(pi, "session_stop", context, review)).toEqual({
      continue: true,
      additionalContext: expect.stringContaining("fix them"),
    });
  });

  it("opens the interactive user-decision preview without starting a review", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop-preview");
    if (!command) throw new Error("review-loop-preview command was not registered");

    await command.handler("", context);

    // The preview is an inline (non-overlay) UI that replaces the editor area
    expect(context.ui.custom).toHaveBeenCalledWith(expect.any(Function));
    expect(pi.sentMessages).toHaveLength(0);
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Review decision preview closed.",
      "info",
    );
  });

  it("starts fixing with an English prompt when every issue is decided", async () => {
    const { pi, context } = installExtension();
    context.ui.custom.mockResolvedValueOnce({
      cancelled: false,
      decisions: [
        { id: "long-user-name", value: "Postpone", type: "preset" },
        { id: "payment-failure-message", value: "保留対応", type: "custom" },
      ],
    });
    const command = pi.commands.get("review-loop-preview");
    if (!command) throw new Error("review-loop-preview command was not registered");

    await command.handler("", context);

    expect(pi.sentMessages).toHaveLength(1);
    const prompt = pi.sentMessages[0].content;
    expect(prompt).toContain(
      "Long user names overflow the admin list: Postpone",
    );
    expect(prompt).toContain(
      "Payment failures do not explain the next step: 保留対応",
    );
    expect(prompt).toContain("Apply only safe, actionable fixes");
    expect(context.ui.notify).toHaveBeenCalledWith(
      "All findings decided. Starting fixes.",
      "info",
    );
  });

  it("surfaces an error when the decision fix prompt cannot be queued", async () => {
    const { pi, context } = installExtension();
    context.ui.custom.mockResolvedValueOnce({
      cancelled: false,
      decisions: [
        { id: "long-user-name", value: "Postpone", type: "preset" },
        { id: "payment-failure-message", value: "Postpone", type: "preset" },
      ],
    });
    pi.sendUserMessage.mockRejectedValueOnce(new Error("queue failed"));
    const command = pi.commands.get("review-loop-preview");
    if (!command) throw new Error("review-loop-preview command was not registered");

    await command.handler("", context);

    expect(context.ui.notify).toHaveBeenCalledWith(
      "Could not start fixing: queue failed",
      "error",
    );
  });

  it("ignores a provider error run and continues with the retried run", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);
    // The runtime delivers a retryable error as an assistant message with
    // stopReason "error" (no willRetry field); the retried run emits a clean
    // agent_end afterwards, so the loop must wait for that one.
    await emit(pi, "agent_end", context, {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "rate limited" }],
          stopReason: "error",
        },
      ],
    });

    expect(pi.sentMessages).toHaveLength(1);
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ phase: "reviewing", round: 1 }),
    });

    await emit(pi, "agent_end", context, assistantEvent("No findings remain."));
    await emit(pi, "agent_settled", context);

    expect(pi.sentMessages).toHaveLength(2);
    expect(pi.sentMessages[1]).toEqual({
      content: expect.stringContaining("fix them"),
      options: undefined,
    });
  });

  it("stops with a protocol error when a provider error is not retried", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);
    // Retries exhausted (or disabled): no clean agent_end follows the error
    // run, so the settled event must stop the loop instead of waiting.
    await emit(pi, "agent_end", context, {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "rate limited" }],
          stopReason: "error",
        },
      ],
    });
    await emit(pi, "agent_settled", context);

    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "stopped: protocol_error",
    );
    expect(context.ui.notify).toHaveBeenCalledWith(
      "The agent ended without a review-loop result. The loop was stopped.",
      "error",
    );
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ stopReason: "protocol_error" }),
    });
  });

  it("stops when the initial review prompt cannot be queued", async () => {
    const { pi, context } = installExtension();
    pi.sendUserMessage.mockRejectedValueOnce(new Error("queue failed"));
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);

    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "stopped: protocol_error",
    );
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Could not start the review loop: queue failed",
      "error",
    );
  });

  it("stops when a follow-up prompt cannot be queued", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    pi.exec.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    });
    await command.handler("2", context);
    pi.sendUserMessage.mockRejectedValueOnce(new Error("queue failed"));

    await emit(pi, "agent_end", context, assistantEvent("A finding remains."));
    await emit(pi, "agent_settled", context);

    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "stopped: protocol_error",
    );
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Could not queue the next review-loop step: queue failed",
      "error",
    );
  });

  it("limits concurrent hashing of untracked files", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    let activeHashes = 0;
    let peakHashes = 0;
    pi.exec.mockImplementation(async (_command, args) => {
      if (args[0] === "status") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "diff" || args[0] === "--cached") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "ls-files") {
        return {
          stdout: Array.from({ length: 32 }, (_, index) => `file-${index}\0`).join(""),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      activeHashes += 1;
      peakHashes = Math.max(peakHashes, activeHashes);
      await Promise.resolve();
      activeHashes -= 1;
      return {
        stdout: `hash-${args.at(-1)}`,
        stderr: "",
        code: 0,
        killed: false,
      };
    });

    await command.handler("2", context);
    await emit(pi, "agent_end", context, assistantEvent("A finding remains."));

    expect(peakHashes).toBeLessThanOrEqual(8);
  });

  it("sends fix them after prose reviews and completes when the final fix changes nothing", async () => {
    const configDirectory = await mkdtemp(
      join("/tmp", "pi-review-loop-global-config-"),
    );
    temporaryDirectories.push(configDirectory);
    vi.stubEnv("PI_CODING_AGENT_DIR", configDirectory);
    const { pi, context } = installExtension();
    const projectDirectory = await mkdtemp(
      join("/tmp", "pi-review-loop-project-"),
    );
    temporaryDirectories.push(projectDirectory);
    context.cwd = projectDirectory;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(5_939_999);
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);
    expect(pi.sentMessages[0]).toEqual({
      content: DEFAULT_REVIEW_PROMPT,
      options: { expandPromptTemplates: true },
    });
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "loop 1/10 · reviewing",
    );

    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("Review found two actionable findings and one item needing a user decision."),
    );
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "loop 1/10 · fixing",
    );
    await emit(pi, "agent_settled", context);
    expect(pi.sentMessages[1]).toEqual({
      content: expect.stringContaining("fix them"),
      options: undefined,
    });

    await emit(pi, "tool_execution_end", context, toolEnd("edit"));
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("The safe fixes were applied; one decision remains pending."),
    );
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "loop 2/10 · reviewing",
    );
    await emit(pi, "agent_settled", context);
    expect(pi.sentMessages[2]).toEqual({
      content: expect.stringContaining("/skill:code-review"),
      options: { expandPromptTemplates: true },
    });

    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("No additional findings remain."),
    );
    await emit(pi, "agent_settled", context);
    expect(pi.sentMessages[3]).toEqual({
      content: expect.stringContaining("fix them"),
      options: undefined,
    });

    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("No safe changes are needed."),
    );
    await emit(pi, "agent_settled", context);

    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      undefined,
    );
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Review loop completed after 2 loops in 1 hour 38 mins.",
      "warning",
    );
    expect(context.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Final review result:\n"),
      expect.anything(),
    );
    expect(pi.entries).toContainEqual({
      type: "pi-review-loop-result",
      data: { content: expect.stringContaining("Final review result:\n") },
    });
    expect(pi.entryRenderers.has("pi-review-loop-result")).toBe(true);
    const resultRenderer = pi.entryRenderers.get("pi-review-loop-result");
    if (!resultRenderer) throw new Error("result renderer was not registered");
    expect(
      resultRenderer({ data: { content: "Final review result:\nclean" } }),
    ).toBeInstanceOf(AssistantMessageComponent);
    expect(context.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Review loop completed. Final review result:"),
      "warning",
    );
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({
        phase: "completed",
        round: 2,
        duration: "1 hour 38 mins",
        completionReason: "no_changes",
        pendingReview: expect.stringContaining("No additional findings remain."),
      }),
    });
    expect(JSON.stringify(pi.sentMessages)).not.toContain(
      "review_loop_report",
    );
  });

  it("uses the trusted project review prompt configuration", async () => {
    const directory = await mkdtemp(join("/tmp", "pi-review-loop-config-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, ".pi"), { recursive: true });
    await writeFile(
      join(directory, ".pi", "review-loop.json"),
      JSON.stringify({ reviewPrompt: "Review only the authentication flow." }),
    );
    const { pi, context } = installExtension();
    context.cwd = directory;
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);

    // 無効化中はカスタム reviewPrompt にも JSON 出力指示は付与されない
    expect(pi.sentMessages[0].content).toBe("Review only the authentication flow.");
  });

  it("accepts a review prompt without an explicit round limit", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("Focus on authorization checks", context);

    expect(pi.sentMessages[0].content).toContain(
      "Additional review instructions: Focus on authorization checks",
    );
    expect(pi.entries[0]).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ maxRounds: 10 }),
    });
  });

  it("accepts a round limit and carries the review prompt into later reviews", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("3 Focus on authorization checks", context);
    expect(pi.sentMessages[0].content).toContain(
      "Additional review instructions: Focus on authorization checks",
    );
    expect(pi.entries[0]).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ maxRounds: 3 }),
    });

    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("One actionable finding remains."),
    );
    await emit(pi, "agent_settled", context);
    await emit(pi, "tool_execution_end", context, toolEnd("write"));
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("The finding was fixed."),
    );
    await emit(pi, "agent_settled", context);

    expect(pi.sentMessages[2].content).toContain(
      "Additional review instructions: Focus on authorization checks",
    );
  });

  it("records a user-decision item when no safe fix is made", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("This issue requires a user decision before changing behavior."),
    );
    await emit(pi, "agent_settled", context);
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("I left the decision pending."),
    );
    await emit(pi, "agent_settled", context);

    // 無効化中は修正プロンプトに JSON 出力指示が含まれない
    expect(pi.sentMessages[1].content).not.toContain("fenced json block");
    expect(context.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Final review result:\n"),
      expect.anything(),
    );
    expect(pi.entries).toContainEqual({
      type: "pi-review-loop-result",
      data: {
        content: expect.stringContaining("User decisions required"),
      },
    });
    expect(pi.entries).toContainEqual({
      type: "pi-review-loop-result",
      data: {
        content: expect.stringContaining(
          "Review the following findings and choose an action for each one.",
        ),
      },
    });
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({
        phase: "completed",
        completionReason: "no_changes",
        pendingReview: expect.stringContaining("I left the decision pending."),
      }),
    });
  });

  it("keeps the decision UI disabled at completion and falls back to a text result", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context, "1");
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent(`Review found one finding.\n\n${DECISION_JSON}`),
    );

    // UI 無効中は TUI モードで item がパースできても決定画面は開かない
    expect(context.ui.custom).not.toHaveBeenCalled();
    expect(context.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Decision preview closed"),
      "info",
    );
    // 保留中の finding はテキストフォールバックの entry に一覧される
    expect(pi.entries).toContainEqual({
      type: "pi-review-loop-result",
      data: { content: expect.stringContaining("User decisions required") },
    });
    // UI 無効中は決定に基づく修正プロンプトはキューされない
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("exits pi immediately on Ctrl+C in the decision UI", async () => {
    const { pi, context } = installExtension();
    let component: { handleInput(data: string): void } | undefined;
    // ctx.shutdown() is deferred until agent_settled, so it cannot exit while the
    // agent is idle. The extension must therefore use an immediate shutdown path;
    // intercept the self-sent SIGTERM to pin that wiring.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const command = pi.commands.get("review-loop-preview");
    if (!command) throw new Error("review-loop-preview command was not registered");
    try {
      context.ui.custom.mockImplementation(
        async (factory: (...args: unknown[]) => unknown) => {
          component = factory(
            { requestRender: () => {}, stop: () => {}, terminal: { rows: 60 } },
            {
              fg: (_c: string, t: string) => t,
              bg: (_c: string, t: string) => t,
              bold: (t: string) => t,
              italic: (t: string) => t,
            },
            {},
            () => {},
          ) as { handleInput(data: string): void };
          return { cancelled: false, decisions: [] };
        },
      );

      // 決定 UI はループ完了時に無効化中のため、wiring はプレビュー経由で検証する
      await command.handler("", context);

      expect(component).toBeDefined();
      component?.handleInput("\u0003");

      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("shows the text result instead of the UI outside TUI mode", async () => {
    const { pi, context } = installExtension();
    context.mode = "rpc";
    context.hasUI = false;

    await runLoop(pi, context, "1");
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent(`Review found one finding.\n\n${DECISION_JSON}`),
    );

    expect(context.ui.custom).not.toHaveBeenCalled();
    expect(pi.entries).toContainEqual({
      type: "pi-review-loop-result",
      data: { content: expect.stringContaining("User decisions required") },
    });
  });

  it("completes the final prose review at the round limit", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("1", context);
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("One finding remains for user review."),
    );
    await emit(pi, "agent_settled", context);

    expect(pi.sentMessages).toHaveLength(1);
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      undefined,
    );
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({
        phase: "completed",
        completionReason: "max_rounds",
        pendingReview: expect.stringContaining("One finding remains"),
      }),
    });
  });

  it("stops with a protocol error when a review has no prose result", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);
    await emit(pi, "agent_end", context, { messages: [] });
    await emit(pi, "agent_settled", context);

    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "stopped: protocol_error",
    );
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ stopReason: "protocol_error" }),
    });
  });

  it("pauses a review turn aborted before it produced a result", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, abortedEvent());

    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "paused 1/10 · reviewing",
    );
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({
        phase: "paused",
        pausedFrom: "reviewing",
      }),
    });
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Review loop paused. Send go on or run /review-loop resume to continue.",
      "warning",
    );

    // Settling after the abort must not stop the paused loop.
    await emit(pi, "agent_settled", context);

    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({
        phase: "paused",
        pausedFrom: "reviewing",
      }),
    });
  });

  it("pauses a fixing turn aborted before it produced a result", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, assistantEvent("A finding remains."));
    await emit(pi, "agent_settled", context);
    await emit(pi, "agent_end", context, abortedEvent());

    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "paused 1/10 · fixing",
    );
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({
        phase: "paused",
        pausedFrom: "fixing",
      }),
    });
  });

  it("treats an aborted review that already produced a result as a completed review", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "No findings remain." }],
          stopReason: "aborted",
        },
      ],
    });

    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "loop 1/10 · fixing",
    );
  });

  it("resumes a paused review when the user sends go on", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, abortedEvent());
    const result = await emit(pi, "input", context, {
      text: "go on",
      source: "interactive",
    });

    expect(result).toEqual({ action: "handled" });
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "loop 1/10 · reviewing",
    );
    expect(pi.sentMessages.at(-1)).toEqual({
      content: DEFAULT_REVIEW_PROMPT,
      options: { expandPromptTemplates: true },
    });

    // The resumed review continues the loop into fixing.
    await emit(pi, "agent_end", context, assistantEvent("A finding remains."));
    await emit(pi, "agent_settled", context);
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "loop 1/10 · fixing",
    );
    expect(pi.sentMessages.at(-1)).toEqual({
      content: expect.stringContaining("fix them"),
      options: undefined,
    });
  });

  it("resumes a paused fix when the user sends go on", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, assistantEvent("A finding remains."));
    await emit(pi, "agent_settled", context);
    await emit(pi, "agent_end", context, abortedEvent());
    const result = await emit(pi, "input", context, {
      text: "go on",
      source: "interactive",
    });

    expect(result).toEqual({ action: "handled" });
    expect(pi.sentMessages.at(-1)).toEqual({
      content: expect.stringContaining("fix them"),
      options: undefined,
    });
  });

  it("matches resume phrases case-insensitively and ignores surrounding whitespace", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, abortedEvent());
    const result = await emit(pi, "input", context, {
      text: "  GO ON  ",
      source: "interactive",
    });

    expect(result).toEqual({ action: "handled" });
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ phase: "reviewing", round: 1 }),
    });
  });

  it("stops a paused loop when the user sends other input", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, abortedEvent());
    const result = await emit(pi, "input", context, {
      text: "explain the change",
      source: "interactive",
    });

    expect(result).toBeUndefined();
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ phase: "stopped", stopReason: "abort" }),
    });
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Review loop stopped: user input received.",
      "warning",
    );
  });

  it("resumes a paused loop with /review-loop resume and refuses when not paused", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context, "resume");
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Review loop is not paused.",
      "info",
    );
    expect(pi.sentMessages).toHaveLength(0);

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, abortedEvent());
    await runLoop(pi, context, "resume");

    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "loop 1/10 · reviewing",
    );
    expect(pi.sentMessages.at(-1)).toEqual({
      content: DEFAULT_REVIEW_PROMPT,
      options: { expandPromptTemplates: true },
    });
  });

  it("cancels a paused loop with /review-loop stop without aborting the agent", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, abortedEvent());
    await runLoop(pi, context, "stop");

    expect(context.abort).not.toHaveBeenCalled();
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "stopped: abort",
    );
  });

  it("does not start a new loop while paused", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, abortedEvent());
    await runLoop(pi, context);

    expect(pi.sentMessages).toHaveLength(1);
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Review loop is paused. Send go on or run /review-loop resume to continue.",
      "warning",
    );
  });

  it("persists a shutdown stop while paused", async () => {
    const { pi, context } = installExtension();

    await runLoop(pi, context);
    await emit(pi, "agent_end", context, abortedEvent());
    await emit(pi, "session_shutdown", context);

    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ phase: "stopped", stopReason: "shutdown" }),
    });
  });

  it("does not start twice and supports explicit stop", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);
    await command.handler("", context);
    expect(pi.sentMessages).toHaveLength(1);
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Review loop is already running.",
      "warning",
    );

    await command.handler("stop", context);
    expect(context.abort).toHaveBeenCalledOnce();
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      "stopped: abort",
    );
  });

  it("does not start while the agent is busy", async () => {
    const { pi, context } = installExtension();
    context.isIdle = vi.fn(() => false);
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);

    expect(pi.sentMessages).toHaveLength(0);
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Agent is busy. Start the review loop after it becomes idle.",
      "warning",
    );
  });

  it("rejects round limits outside the supported range", async () => {
    const agentDirectory = await mkdtemp(
      join("/tmp", "pi-review-loop-global-config-"),
    );
    temporaryDirectories.push(agentDirectory);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("0", context);
    await command.handler("11", context);

    expect(pi.sentMessages).toHaveLength(0);
    expect(lastStateEntry(pi)).toBeUndefined();
    expect(context.ui.notify).toHaveBeenCalledTimes(2);
    expect(context.ui.notify).toHaveBeenCalledWith(
      "maxRounds must be between 1 and 10",
      "warning",
    );
  });

  it("ignores the project review prompt when the project is not trusted", async () => {
    const agentDirectory = await mkdtemp(
      join("/tmp", "pi-review-loop-global-config-"),
    );
    temporaryDirectories.push(agentDirectory);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
    const directory = await mkdtemp(join("/tmp", "pi-review-loop-config-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, ".pi"), { recursive: true });
    await writeFile(
      join(directory, ".pi", "review-loop.json"),
      JSON.stringify({ reviewPrompt: "Review only the authentication flow." }),
    );
    const { pi, context } = installExtension();
    context.cwd = directory;
    context.isProjectTrusted = vi.fn(() => false);
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);

    expect(pi.sentMessages[0].content).toBe(DEFAULT_REVIEW_PROMPT);
  });

  it("falls back to tool detection when git commands are killed", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    // A timed-out git command resolves with code 0 and truncated output, so
    // truncated fingerprints must be discarded instead of compared.
    let statusCalls = 0;
    pi.exec.mockImplementation(async (_command, args) => {
      if (args[0] === "status") {
        statusCalls += 1;
        return {
          stdout: `truncated-${statusCalls}`,
          stderr: "",
          code: 0,
          killed: true,
        };
      }
      return { stdout: "", stderr: "", code: 0, killed: true };
    });

    await command.handler("", context);
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("One finding remains."),
    );
    await emit(pi, "agent_settled", context);
    expect(pi.sentMessages[1].content).toContain("fix them");

    // No edit/write tool ran, so the fix is treated as a no-op.
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("No safe changes are needed."),
    );
    await emit(pi, "agent_settled", context);

    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({
        phase: "completed",
        completionReason: "no_changes",
      }),
    });
  });

  it("persists a stopped state on session shutdown", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);
    await emit(pi, "session_shutdown", context);

    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ phase: "stopped", stopReason: "shutdown" }),
    });
  });

  it("stops the loop when the user submits external input", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);
    await emit(pi, "input", context, { text: "hold on", source: "interactive" });

    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ phase: "stopped", stopReason: "abort" }),
    });
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Review loop stopped: user input received.",
      "warning",
    );

    // A late review result must not resume the loop or queue a fix prompt.
    await emit(pi, "agent_end", context, assistantEvent("A finding remains."));
    await emit(pi, "agent_settled", context);

    expect(pi.sentMessages).toHaveLength(1);
  });

  it("keeps running on extension-originated input", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    await command.handler("", context);
    await emit(pi, "input", context, { text: "fix them", source: "extension" });

    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({ phase: "reviewing", round: 1 }),
    });
  });

  it("aborts fingerprinting when the overall deadline is exceeded", async () => {
    const { pi, context } = installExtension();
    const command = pi.commands.get("review-loop");
    if (!command) throw new Error("review-loop command was not registered");

    // Simulate a slow disk: every git call advances the clock by 4s, so with
    // 17 untracked files the second hash batch must be cut off by the
    // fingerprint deadline instead of spawning more processes.
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let hashCalls = 0;
    pi.exec.mockImplementation(async (_command, args) => {
      now += 4_000;
      if (args[0] === "ls-files") {
        return {
          stdout: Array.from({ length: 17 }, (_, index) =>
            `file-${index}\0`,
          ).join(""),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (args[0] === "hash-object") hashCalls += 1;
      return {
        stdout: args[0] === "hash-object" ? "hash" : "",
        stderr: "",
        code: 0,
        killed: false,
      };
    });

    await command.handler("", context);
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("One finding remains."),
    );
    await emit(pi, "agent_settled", context);
    await emit(
      pi,
      "agent_end",
      context,
      assistantEvent("No safe changes are needed."),
    );
    await emit(pi, "agent_settled", context);

    expect(hashCalls).toBe(8);
    expect(lastStateEntry(pi)).toEqual({
      type: "pi-review-loop-state",
      data: expect.objectContaining({
        phase: "completed",
        completionReason: "no_changes",
      }),
    });
  });

  it("does not auto-resume persisted state when a new extension instance starts", async () => {
    const entries = [
      {
        type: "custom",
        customType: "pi-review-loop-state",
        data: { phase: "fixing", round: 1, maxRounds: 5 },
      },
    ];
    const context = createContext({
      sessionManager: { getEntries: () => entries },
    });
    const pi = new FakePi();
    reviewLoopExtension(pi as unknown as ExtensionAPI);

    await emit(pi, "session_start", context);

    expect(pi.sentMessages).toHaveLength(0);
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-review-loop",
      undefined,
    );
  });

  it("does not expose a review_loop_report tool", () => {
    const { pi } = installExtension();

    expect(pi.getActiveTools()).not.toContain("review_loop_report");
    expect(pi.events.has("tool_execution_end")).toBe(true);
  });
});
