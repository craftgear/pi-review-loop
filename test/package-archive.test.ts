import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageMetadata {
  files: Array<{ path: string }>;
}

function isPackageMetadata(value: unknown): value is PackageMetadata {
  if (typeof value !== "object" || value === null || !("files" in value))
    return false;
  const files = (value as { files?: unknown }).files;
  return Array.isArray(files);
}

describe("Pi package archive", () => {
  it("contains runtime resources and excludes test files", () => {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    const metadata = Array.isArray(parsed)
      ? isPackageMetadata(parsed[0])
        ? parsed[0]
        : undefined
      : isPackageMetadata(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null
          ? Object.values(parsed as Record<string, unknown>).find(
              isPackageMetadata,
            )
          : undefined;
    const files = metadata?.files?.map((file) => file.path) ?? [];

    expect(files).toEqual(
      expect.arrayContaining([
        "README.md",
        "extensions/review-loop.ts",
        "package.json",
        "src/reviewLoopConfig.ts",
        "src/reviewLoopState.ts",
      ]),
    );
    expect(files).not.toContain("skills/code-review/SKILL.md");
    expect(files.some((file) => file.startsWith("test/"))).toBe(false);
    expect(files.some((file) => file === "vitest.config.ts")).toBe(false);
  });
});
