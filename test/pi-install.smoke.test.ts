import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piCli = resolve(
  packageRoot,
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Pi install smoke", () => {
  it("loads the extension and an existing code-review skill", async () => {
    const projectDirectory = await mkdtemp(
      join("/tmp", "pi-review-loop-test-"),
    );
    temporaryDirectories.push(projectDirectory);

    const install = spawnSync(
      process.execPath,
      [piCli, "install", "-l", packageRoot, "--approve"],
      { cwd: projectDirectory, encoding: "utf8" },
    );
    expect(install.status, install.stderr).toBe(0);

    const agentDirectory = join(projectDirectory, "agent");
    const codeReviewSkillPath = join(
      agentDirectory,
      "skills",
      "code-review",
      "SKILL.md",
    );
    await mkdir(join(agentDirectory, "skills", "code-review"), {
      recursive: true,
    });
    await writeFile(
      codeReviewSkillPath,
      "---\nname: code-review\ndescription: Review worktree changes.\n---\nReview the current worktree changes.\n",
    );
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDirectory, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const result = await createAgentSession({
      cwd: projectDirectory,
      agentDir: agentDirectory,
      modelRuntime,
      sessionManager: SessionManager.inMemory(projectDirectory),
      tools: ["read", "bash", "edit", "write"],
    });

    expect(result.extensionsResult.errors).toEqual([]);
    expect(
      result.extensionsResult.extensions.flatMap((extension) => [
        ...extension.commands.keys(),
      ]),
    ).toContain("review-loop");
    expect(result.session.getActiveToolNames()).not.toContain(
      "review_loop_report",
    );
    expect(
      result.session.resourceLoader.getSkills().skills.find(
        (skill) => skill.name === "code-review",
      ),
    ).toMatchObject({ filePath: codeReviewSkillPath });

    result.session.dispose();
  });
});
