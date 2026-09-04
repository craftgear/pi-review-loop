import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_PROMPT,
  loadReviewPrompt,
} from "../src/reviewLoopConfig";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("review loop config", () => {
  it("uses the requested default when no config file exists", () => {
    expect(loadReviewPrompt(["/tmp/pi-review-loop-global.json"])).toEqual({
      prompt: DEFAULT_REVIEW_PROMPT,
      warnings: [],
    });
  });

  it("lets the project config override the global config", async () => {
    const directory = await mkdtemp(join("/tmp", "pi-review-loop-config-"));
    temporaryDirectories.push(directory);
    const projectConfigDirectory = join(directory, ".pi");
    await mkdir(projectConfigDirectory, { recursive: true });
    const globalPath = join(directory, "global.json");
    const projectPath = join(projectConfigDirectory, "review-loop.json");
    await writeFile(
      globalPath,
      JSON.stringify({ reviewPrompt: "Review the whole worktree." }),
    );
    await writeFile(
      projectPath,
      JSON.stringify({ reviewPrompt: "Review only the authentication flow." }),
    );

    expect(loadReviewPrompt([globalPath, projectPath])).toEqual({
      prompt: "Review only the authentication flow.",
      warnings: [],
    });
  });

  it("keeps the previous value and reports invalid config", async () => {
    const directory = await mkdtemp(join("/tmp", "pi-review-loop-config-"));
    temporaryDirectories.push(directory);
    const globalPath = join(directory, "global.json");
    const projectPath = join(directory, "project.json");
    await writeFile(
      globalPath,
      JSON.stringify({ reviewPrompt: "Review the whole worktree." }),
    );
    await writeFile(projectPath, JSON.stringify({ reviewPrompt: "   " }));

    const result = loadReviewPrompt([globalPath, projectPath]);

    expect(result.prompt).toBe("Review the whole worktree.");
    expect(result.warnings).toHaveLength(1);
  });

  it("keeps the default and reports unreadable config", async () => {
    const directory = await mkdtemp(join("/tmp", "pi-review-loop-config-"));
    temporaryDirectories.push(directory);
    const brokenPath = join(directory, "broken.json");
    await writeFile(brokenPath, "{ not valid json");

    expect(loadReviewPrompt([brokenPath])).toEqual({
      prompt: DEFAULT_REVIEW_PROMPT,
      warnings: [expect.stringContaining("Could not load review-loop config")],
    });
  });
});
