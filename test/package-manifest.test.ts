import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Pi package manifest", () => {
  it("registers only the review loop extension", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ) as {
      license?: string;
      keywords?: string[];
      engines?: { node?: string };
      pi?: {
        extensions?: string[];
        skills?: string[];
      };
    };

    expect(packageJson.license).toBe("MIT");
    expect(packageJson.keywords).toContain("pi-package");
    expect(packageJson.engines?.node).toBe(">=22.19.0");
    expect(packageJson.pi).toEqual({
      extensions: ["./extensions/review-loop.ts"],
    });
    expect(packageJson.pi?.skills).toBeUndefined();
  });
});
