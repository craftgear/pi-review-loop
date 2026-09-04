import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_REVIEW_PROMPT =
  "/skill:code-review Review the current working tree changes for security, correctness, performance, and missing tests. Do not modify files during this review.";

interface ReviewLoopConfig {
  reviewPrompt?: unknown;
}

export interface ReviewPromptConfig {
  prompt: string;
  warnings: string[];
}

function isReviewLoopConfig(value: unknown): value is ReviewLoopConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadReviewPrompt(
  configPaths: readonly string[],
): ReviewPromptConfig {
  let prompt = DEFAULT_REVIEW_PROMPT;
  const warnings: string[] = [];

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;

    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      if (!isReviewLoopConfig(config)) {
        warnings.push(`Review-loop config must be a JSON object: ${configPath}`);
        continue;
      }
      if (!("reviewPrompt" in config)) continue;
      if (
        typeof config.reviewPrompt !== "string" ||
        !config.reviewPrompt.trim()
      ) {
        warnings.push(
          `Review-loop config has an invalid reviewPrompt: ${configPath}`,
        );
        continue;
      }
      prompt = config.reviewPrompt.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not load review-loop config ${configPath}: ${message}`);
    }
  }

  return { prompt, warnings };
}
