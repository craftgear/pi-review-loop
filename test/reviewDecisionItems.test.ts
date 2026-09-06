import { describe, expect, it } from "vitest";
import { parseDecisionItems } from "../src/reviewDecisionItems";

const JSON_BLOCK = [
  "```json",
  "[",
  "  {",
  '    "id": "admin-list-overflow",',
  '    "title": "Long user names overflow the admin list",',
  '    "category": "ui",',
  '    "priority": "low",',
  '    "recommendation": "Postpone is acceptable for this release.",',
  '    "impact": "Only the admin display is affected.",',
  '    "criteria": ["The full name is available on the detail screen."],',
  '    "actions": ["Fix in this release", "Postpone"]',
  "  }",
  "]",
  "```",
].join("\n");

describe("parseDecisionItems", () => {
  it("parses a fenced json block from surrounding prose", () => {
    const text = `Review found one finding that needs a decision.\n\n${JSON_BLOCK}\n\nPlease review.`;

    expect(parseDecisionItems(text)).toEqual([
      {
        id: "admin-list-overflow",
        title: "Long user names overflow the admin list",
        category: "ui",
        priority: "low",
        recommendation: "Postpone is acceptable for this release.",
        impact: "Only the admin display is affected.",
        criteria: ["The full name is available on the detail screen."],
        actions: ["Fix in this release", "Postpone"],
      },
    ]);
  });

  it("defaults missing priority to medium and empties for missing fields", () => {
    const text =
      "```json\n[{ \"id\": \"a\", \"title\": \"A\", \"actions\": [\"Do it\"] }]\n```";

    expect(parseDecisionItems(text)).toEqual([
      {
        id: "a",
        title: "A",
        category: "",
        priority: "medium",
        recommendation: "",
        impact: "",
        criteria: [],
        actions: ["Do it"],
      },
    ]);
  });

  it("skips malformed blocks and invalid entries, keeping valid ones", () => {
    const text = [
      "```json",
      "[ { not json ]",
      "```",
      "",
      "```json",
      "[",
      '  { "id": "", "title": "Missing id", "actions": ["x"] },',
      '  { "id": "no-actions", "title": "No actions", "actions": [] },',
      '  { "id": "good", "title": "Good", "actions": ["Fix"] }',
      "]",
      "```",
    ].join("\n");

    expect(parseDecisionItems(text)).toEqual([
      {
        id: "good",
        title: "Good",
        category: "",
        priority: "medium",
        recommendation: "",
        impact: "",
        criteria: [],
        actions: ["Fix"],
      },
    ]);
  });

  it("deduplicates repeated ids", () => {
    const text =
      "```json\n[\n" +
      '  { "id": "dup", "title": "First", "actions": ["A"] },\n' +
      '  { "id": "dup", "title": "Second", "actions": ["B"] }\n' +
      "]\n```";

    expect(parseDecisionItems(text)).toEqual([
      {
        id: "dup",
        title: "First",
        category: "",
        priority: "medium",
        recommendation: "",
        impact: "",
        criteria: [],
        actions: ["A"],
      },
    ]);
  });

  it("returns undefined when there is no usable json block", () => {
    expect(
      parseDecisionItems("Review complete. One item requires a user decision."),
    ).toBeUndefined();
    expect(parseDecisionItems("```json\n[]\n```")).toBeUndefined();
    // A json object (not an array) is not a decision list
    expect(parseDecisionItems("```json\n{ \"id\": \"a\" }\n```")).toBeUndefined();
  });
});
