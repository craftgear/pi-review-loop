import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(packageRoot, "extensions/review-loop.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function messageText(message: {
  content: string | Array<{ type: string; text?: string }>;
}): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

describe("Pi runtime integration", () => {
  it("ignores a retryable provider error before completing the review", async () => {
    const projectDirectory = await mkdtemp(
      join("/tmp", "pi-review-loop-runtime-retry-"),
    );
    temporaryDirectories.push(projectDirectory);

    const agentDirectory = join(projectDirectory, "agent");
    const codeReviewSkillPath = join(
      agentDirectory,
      "skills",
      "code-review",
      "SKILL.md",
    );
    await mkdir(dirname(codeReviewSkillPath), { recursive: true });
    await writeFile(
      codeReviewSkillPath,
      "---\nname: code-review\ndescription: Review worktree changes.\n---\nReview the current worktree changes.\n",
    );
    await writeFile(
      join(agentDirectory, "settings.json"),
      JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } }),
    );

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDirectory, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({
      provider: "pi-review-loop-retry-test",
      models: [
        {
          id: "loop-model",
          name: "Loop Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("Temporary provider failure", {
        stopReason: "error",
        errorMessage: "rate limit",
      }),
      fauxAssistantMessage("No findings remain.", { stopReason: "stop" }),
    ]);

    const resourceLoader = new (
      await import("@earendil-works/pi-coding-agent")
    ).DefaultResourceLoader({
      cwd: projectDirectory,
      agentDir: agentDirectory,
      additionalExtensionPaths: [extensionPath],
    });
    await resourceLoader.reload();
    const { session, extensionsResult } = await createAgentSession({
      cwd: projectDirectory,
      agentDir: agentDirectory,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader,
      sessionManager: SessionManager.inMemory(projectDirectory),
      tools: ["read", "bash", "edit", "write"],
    });

    const settled = new Promise<void>((resolveSettled) => {
      session.subscribe((event) => {
        if (event.type === "agent_settled") resolveSettled();
      });
    });

    await session.prompt("/review-loop 1", { expandPromptTemplates: true });
    await settled;

    expect(extensionsResult.errors).toEqual([]);
    expect(faux.state.callCount).toBe(2);
    expect(
      session.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi-review-loop-state",
        )
        .at(-1),
    ).toMatchObject({
      customType: "pi-review-loop-state",
      data: { phase: "completed", completionReason: "max_rounds" },
    });

    session.dispose();
  });

  it("uses prose reviews, sends fix them, and settles without a report tool", async () => {
    const projectDirectory = await mkdtemp(
      join("/tmp", "pi-review-loop-runtime-"),
    );
    temporaryDirectories.push(projectDirectory);

    const codeReviewSkillPath = join(
      projectDirectory,
      "agent",
      "skills",
      "code-review",
      "SKILL.md",
    );
    await mkdir(dirname(codeReviewSkillPath), { recursive: true });
    await writeFile(
      codeReviewSkillPath,
      "---\nname: code-review\ndescription: Review worktree changes.\n---\nReview the current worktree changes.\n",
    );
    await mkdir(join(projectDirectory, ".pi"), { recursive: true });
    await writeFile(
      join(projectDirectory, ".pi", "review-loop.json"),
      JSON.stringify({
        reviewPrompt:
          "/skill:code-review Review only the configured review scope.",
      }),
    );

    const modelRuntime = await ModelRuntime.create({
      authPath: join(projectDirectory, "agent/auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({
      provider: "pi-review-loop-test",
      models: [
        {
          id: "loop-model",
          name: "Loop Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("Review complete. One item requires a user decision.", {
        stopReason: "stop",
      }),
      fauxAssistantMessage("fix them\nNo safe changes can be made without user input.", {
        stopReason: "stop",
      }),
    ]);

    const resourceLoader = new (
      await import("@earendil-works/pi-coding-agent")
    ).DefaultResourceLoader({
      cwd: projectDirectory,
      agentDir: join(projectDirectory, "agent"),
      additionalExtensionPaths: [extensionPath],
    });
    await resourceLoader.reload();
    const { session, extensionsResult } = await createAgentSession({
      cwd: projectDirectory,
      agentDir: join(projectDirectory, "agent"),
      modelRuntime,
      model: faux.getModel(),
      resourceLoader,
      sessionManager: SessionManager.inMemory(projectDirectory),
      tools: ["read", "bash", "edit", "write"],
    });

    const settled = new Promise<void>((resolveSettled) => {
      let settledCount = 0;
      session.subscribe((event) => {
        if (event.type === "agent_settled") {
          settledCount += 1;
          if (settledCount === 2) resolveSettled();
        }
      });
    });

    await session.prompt("/review-loop", { expandPromptTemplates: true });
    await settled;

    const userMessages = session.messages.filter(
      (message) => message.role === "user",
    );
    expect(extensionsResult.errors).toEqual([]);
    expect(
      session.resourceLoader.getSkills().skills.find(
        (skill) => skill.name === "code-review",
      ),
    ).toMatchObject({ filePath: codeReviewSkillPath });
    expect(faux.state.callCount).toBe(2);
    expect(userMessages).toHaveLength(2);
    expect(session.getActiveToolNames()).not.toContain("review_loop_report");
    expect(messageText(userMessages[0])).toMatch(/^<skill name="code-review"/);
    expect(messageText(userMessages[0])).toContain(
      "Review only the configured review scope.",
    );
    expect(messageText(userMessages[1])).toContain("fix them");
    expect(
      session.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi-review-loop-state",
        )
        .at(-1),
    ).toMatchObject({
      customType: "pi-review-loop-state",
      data: {
        phase: "completed",
        completionReason: "no_changes",
        pendingReview: expect.stringContaining("requires a user decision"),
      },
    });
    expect(
      session.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi-review-loop-result",
        )
        .at(-1),
    ).toMatchObject({
      customType: "pi-review-loop-result",
      data: { content: expect.stringContaining("Final review result:") },
    });

    session.dispose();
  });
});
