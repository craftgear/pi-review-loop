// ユーザー判断が必要な finding はレビュー/修正プロンプトから fenced json
// ブロックとして出力され、これを決定 UI 用の項目にパースする

export interface ReviewDecisionPreviewItem {
  id: string;
  title: string;
  category: string;
  priority: "high" | "medium" | "low";
  recommendation: string;
  impact: string;
  criteria: readonly string[];
  actions: readonly string[];
}

const PRIORITIES = ["high", "medium", "low"] as const;
type Priority = (typeof PRIORITIES)[number];

// レビュー/修正プロンプトに付ける、判断必要 finding の出力形式指示（英語）
export const DECISION_ITEMS_PROMPT = [
  "For every finding that requires a user decision, include it once in a single fenced json block at the end of your response, one entry per finding, using exactly this shape:",
  "```json",
  "[",
  "  {",
  '    "id": "short-kebab-case-id",',
  '    "title": "One-line summary of the issue",',
  '    "category": "Short noun phrase classifying the finding, e.g. security or performance",',
  '    "priority": "high",',
  '    "recommendation": "One-sentence recommendation.",',
  '    "impact": "Why it matters, in one to two sentences.",',
  '    "criteria": ["Fact or condition that supports the decision"],',
  '    "actions": ["Concrete action option one", "Concrete action option two"]',
  "  }",
  "]",
  "```",
  "priority must be one of high, medium, or low, and actions must list the concrete options the user can choose from.",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeEntry(
  value: unknown,
): ReviewDecisionPreviewItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const category = typeof value.category === "string" ? value.category.trim() : "";
  const actions = toStringList(value.actions);
  // id / title / アクション 1 つでも欠けると判断できないためスキップする
  if (!id || !title || actions.length === 0) return undefined;
  const priority: Priority = PRIORITIES.includes(value.priority as Priority)
    ? (value.priority as Priority)
    : "medium";
  return {
    id,
    title,
    category,
    priority,
    recommendation:
      typeof value.recommendation === "string"
        ? value.recommendation.trim()
        : "",
    impact: typeof value.impact === "string" ? value.impact.trim() : "",
    criteria: toStringList(value.criteria),
    actions,
  };
}

// レスポンス本文の fenced ブロックから最初の有効な決定項目リストを取り出す
export function parseDecisionItems(
  text: string,
): ReviewDecisionPreviewItem[] | undefined {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
    (match) => match[1],
  );
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const items: ReviewDecisionPreviewItem[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      const item = normalizeEntry(entry);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    if (items.length > 0) return items;
  }
  return undefined;
}
