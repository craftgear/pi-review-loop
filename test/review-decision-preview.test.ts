import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  PREVIEW_DECISION_ITEMS,
  ReviewDecisionPreviewComponent,
  type ReviewDecisionPreviewItem,
  type ReviewDecisionPreviewResult,
} from "../extensions/review-decision-preview";

function createTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  } as unknown as Theme;
}

function createTui(rows = 24): TUI {
  return {
    requestRender: vi.fn(),
    stop: vi.fn(),
    terminal: { rows },
  } as unknown as TUI;
}

function createPreview(
  rows = 24,
  items: readonly ReviewDecisionPreviewItem[] = PREVIEW_DECISION_ITEMS,
) {
  let result: ReviewDecisionPreviewResult | undefined;
  const onExit = vi.fn();
  const component = new ReviewDecisionPreviewComponent(
    items,
    createTui(rows),
    createTheme(),
    (nextResult) => {
      result = nextResult;
    },
    onExit,
  );

  return {
    component,
    onExit,
    get result() {
      return result;
    },
  };
}

describe("review decision preview", () => {
  const keys = {
    enter: "\r",
    escape: "\u001b",
    up: "\u001b[A",
    down: "\u001b[B",
    j: "j",
    k: "k",
    space: " ",
    tab: "\t",
  };

  it("opens the selected issue with Space and activates an action without deciding", () => {
    // 60 rows fits the opened issue so no scrolling interferes with assertions
    const preview = createPreview(60);
    const text = () => preview.component.render(80).join("\n");

    expect(text()).toContain("▶ 1.");

    preview.component.handleInput(keys.space);

    expect(text()).toContain("▼ 1.");
    expect(text()).toContain("Impact");
    expect(text()).toContain("Decision criteria");
    expect(text()).toContain("Choose an action");
    // The first action is active, but opening does not record a decision
    expect(text()).toContain("> Fix in this release");
    expect(text()).toContain("0/2 decided");
    expect(text()).not.toContain("Decision: ");

    // Space again collapses the issue and stays on it
    preview.component.handleInput(keys.space);
    expect(text()).toContain("▶ 1.");
    expect(text()).not.toContain("Choose an action");
  });

  it("moves issue selection with Tab/arrows/jk while the issue is closed", () => {
    const { component } = createPreview(60);
    const selectedIssueLine = () =>
      component.render(80).find((line) => line.startsWith("> "));

    expect(selectedIssueLine()).toContain("1.");

    component.handleInput(keys.j);
    expect(selectedIssueLine()).toContain("2.");

    component.handleInput(keys.tab); // wraps to the first issue
    expect(selectedIssueLine()).toContain("1.");

    component.handleInput(keys.k); // previous wraps to the last issue
    expect(selectedIssueLine()).toContain("2.");

    component.handleInput(keys.down); // wraps to the first issue
    expect(selectedIssueLine()).toContain("1.");

    component.handleInput(keys.up); // previous wraps to the last issue
    expect(selectedIssueLine()).toContain("2.");
  });

  it("moves the action selection with Tab/arrows/jk while the issue is open", () => {
    const { component } = createPreview(60);
    const text = () => component.render(80).join("\n");

    component.handleInput(keys.enter); // open issue 1
    expect(text()).toContain("> Fix in this release");

    component.handleInput(keys.tab);
    expect(text()).toContain("> Postpone");

    component.handleInput(keys.down);
    expect(text()).toContain("> Investigate further");

    component.handleInput(keys.j);
    expect(text()).toContain("> Custom decision");

    component.handleInput(keys.k);
    expect(text()).toContain("> Investigate further");

    component.handleInput(keys.up);
    expect(text()).toContain("> Postpone");
  });

  it("confirms the highlighted action with Enter and opens the next issue", () => {
    const preview = createPreview(60);
    const text = () => preview.component.render(80).join("\n");
    const selectedIssueLine = () =>
      preview.component
        .render(80)
        .find((line) => line.startsWith("> "));

    // Open, move to Postpone, confirm: records and advances to issue 2
    preview.component.handleInput(keys.enter);
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.enter);

    expect(text()).toContain("1/2 decided");
    expect(text()).toContain("Decision: Postpone");
    expect(text()).toContain("▶ 1.");
    expect(text()).toContain("▼ 2.");
    expect(selectedIssueLine()).toContain("2.");

    // Close the opened issue, then close the preview
    preview.component.handleInput(keys.space);
    preview.component.handleInput(keys.escape);
    expect(preview.result?.decisions).toEqual([
      { id: "long-user-name", value: "Postpone", type: "preset" },
    ]);
  });

  it("restores a recorded decision when reopening and allows changing it", () => {
    const preview = createPreview(60);
    const text = () => preview.component.render(80).join("\n");
    const selectedIssueLine = () =>
      preview.component
        .render(80)
        .find((line) => line.startsWith("> "));

    // Record "Postpone" for the first issue (advances to issue 2)
    preview.component.handleInput(keys.enter);
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.enter);
    expect(text()).toContain("Decision: Postpone");

    // Close issue 2, go back to issue 1: reopening lands on the recorded action
    preview.component.handleInput(keys.space);
    preview.component.handleInput(keys.tab);
    preview.component.handleInput(keys.enter);
    expect(text()).toContain("> Postpone");

    // Change the selection and confirm it
    preview.component.handleInput(keys.k);
    expect(text()).toContain("> Fix in this release");
    preview.component.handleInput(keys.enter);
    expect(text()).toContain("Decision: Fix in this release");

    preview.component.handleInput(keys.space);
    preview.component.handleInput(keys.escape);
    expect(preview.result?.decisions).toEqual([
      { id: "long-user-name", value: "Fix in this release", type: "preset" },
    ]);
  });

  it("supports a custom decision confirmed via Enter, then opens the next issue", () => {
    // 60 rows fits the list so auto-scroll does not hide the Decision line
    const preview = createPreview(60);
    const text = () => preview.component.render(80).join("\n");

    preview.component.handleInput(keys.enter); // open the issue
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.j); // highlight Custom decision
    preview.component.handleInput(keys.enter); // open the input editor

    expect(text()).toContain("Enter confirm");

    for (const character of "次回リリースで対応") {
      preview.component.handleInput(character);
    }
    preview.component.handleInput(keys.enter); // submit

    // The decision is recorded and the next issue is opened
    expect(text()).toContain("1/2 decided");
    expect(text()).toContain("Decision: 次回リリースで対応");
    expect(text()).toContain("▼ 2.");

    // Close the opened issue, then close the preview
    preview.component.handleInput(keys.space);
    preview.component.handleInput(keys.escape);
    expect(preview.result?.decisions).toEqual([
      {
        id: "long-user-name",
        value: "次回リリースで対応",
        type: "custom",
      },
    ]);
  });

  it("prefills a previous custom decision so it can be changed", () => {
    const preview = createPreview(60);
    const text = () => preview.component.render(80).join("\n");

    // Record a custom decision (advances to issue 2)
    preview.component.handleInput(keys.enter);
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.enter);
    for (const character of "保留") {
      preview.component.handleInput(character);
    }
    preview.component.handleInput(keys.enter);
    expect(text()).toContain("Decision: 保留");

    // Back to issue 1: reopening lands on Custom decision and prefills it
    preview.component.handleInput(keys.space);
    preview.component.handleInput(keys.tab);
    preview.component.handleInput(keys.enter);
    expect(text()).toContain("> Custom decision");

    preview.component.handleInput(keys.enter);
    for (const character of "対応") {
      preview.component.handleInput(character);
    }
    preview.component.handleInput(keys.enter); // submit the edited value

    preview.component.handleInput(keys.space);
    preview.component.handleInput(keys.escape);
    expect(preview.result?.decisions).toEqual([
      { id: "long-user-name", value: "保留対応", type: "custom" },
    ]);
  });

  it("closes the open issue and opens the next one with Esc", () => {
    const { component } = createPreview(60);
    const text = () => component.render(80).join("\n");
    const selectedIssueLine = () =>
      component.render(80).find((line) => line.startsWith("> "));

    component.handleInput(keys.space); // open issue 1
    component.handleInput(keys.escape); // close 1, open 2

    expect(text()).toContain("▶ 1.");
    expect(text()).toContain("▼ 2.");
    expect(selectedIssueLine()).toContain("2.");
    expect(text()).toContain("Choose an action");

    // Wraps: Esc from the last issue opens the first one
    component.handleInput(keys.escape);
    expect(text()).toContain("▼ 1.");
    expect(text()).toContain("▶ 2.");
  });

  it("closes automatically with all decisions once every issue is decided", () => {
    const preview = createPreview(60);

    // Issue 1: custom decision (advances to issue 2)
    preview.component.handleInput(keys.enter);
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.j);
    preview.component.handleInput(keys.enter);
    for (const character of "保留") {
      preview.component.handleInput(character);
    }
    preview.component.handleInput(keys.enter);

    // Issue 2: preset decision - the last undecided one closes the preview on its own
    preview.component.handleInput(keys.enter);

    expect(preview.result).toEqual({
      cancelled: false,
      decisions: [
        { id: "long-user-name", value: "保留", type: "custom" },
        {
          id: "payment-failure-message",
          value: "Fix in this release",
          type: "preset",
        },
      ],
    });

    // Input after the automatic close is ignored
    preview.component.handleInput(keys.escape);
    expect(preview.result?.decisions).toHaveLength(2);
  });

  it("shows the actions inline after the expanded issue details", () => {
    const { component } = createPreview(60);

    component.handleInput(keys.enter);

    const lines = component.render(80);
    const impact = lines.findIndex((line) => line.includes("Impact"));
    const criteria = lines.findIndex((line) =>
      line.includes("Decision criteria"),
    );
    const actionHeading = lines.findIndex((line) =>
      line.includes("Choose an action"),
    );

    expect(impact).toBeGreaterThanOrEqual(0);
    expect(criteria).toBeGreaterThan(impact);
    expect(actionHeading).toBeGreaterThan(criteria);
  });

  it("opens an issue with the action list visible when it starts below the fold", () => {
    // 20 rows keeps the opened issue taller than the viewport so scrolling applies
    const { component } = createPreview(20);

    component.handleInput(keys.enter);

    const text = component.render(80).join("\n");
    expect(text).toContain("Choose an action");
    // The open-state help is shown and the action list starts at the top
    expect(text).toContain("Enter select");
    expect(text).toContain("Esc next issue");
    expect(text).not.toContain("1. Long user names overflow the admin list");
  });

  it("indents the Choose an action heading and its options", () => {
    const { component } = createPreview(60);

    component.handleInput(keys.enter);

    const lines = component.render(80);
    const heading = lines.find((line) => line.includes("Choose an action"));
    expect(heading?.startsWith("    ")).toBe(true);

    // Options sit under the heading: cursor at 4 spaces, option text aligned
    expect(
      lines.find((line) => line.includes("> Fix in this release"))?.startsWith(
        "    ",
      ),
    ).toBe(true);
    expect(lines.some((line) => line.startsWith("      Postpone"))).toBe(true);
  });

  it("colors the active action with the accent color", () => {
    // The shared test theme is a no-op, so record fg() calls to observe colors
    const fgCalls: [string, string][] = [];
    const theme = {
      fg: (color: string, text: string) => {
        fgCalls.push([color, text]);
        return text;
      },
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
    } as unknown as Theme;

    const component = new ReviewDecisionPreviewComponent(
      PREVIEW_DECISION_ITEMS,
      createTui(60),
      theme,
      () => {},
      () => {},
    );

    component.handleInput(keys.enter);
    component.render(80);

    expect(fgCalls).toContainEqual(["accent", "Fix in this release"]);
    expect(
      fgCalls.some(
        ([color, text]) => color === "accent" && text === "Postpone",
      ),
    ).toBe(false);
  });

  it("colors the Choose an action heading with the warning color", () => {
    // The shared test theme is a no-op, so record fg() calls to observe colors
    const fgCalls: [string, string][] = [];
    const theme = {
      fg: (color: string, text: string) => {
        fgCalls.push([color, text]);
        return text;
      },
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
    } as unknown as Theme;

    const component = new ReviewDecisionPreviewComponent(
      PREVIEW_DECISION_ITEMS,
      createTui(60),
      theme,
      () => {},
      () => {},
    );

    component.handleInput(keys.enter);
    component.render(80);

    expect(fgCalls).toContainEqual(["warning", "Choose an action"]);
  });

  it("changes the help text per issue state with keys styled distinctly", () => {
    // The shared test theme is a no-op, so record fg() calls to observe colors
    const fgCalls: [string, string][] = [];
    const theme = {
      fg: (color: string, text: string) => {
        fgCalls.push([color, text]);
        return text;
      },
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
    } as unknown as Theme;

    const component = new ReviewDecisionPreviewComponent(
      PREVIEW_DECISION_ITEMS,
      createTui(60),
      theme,
      () => {},
      () => {},
    );

    component.render(80); // closed issue: movement/open/close help

    for (const key of ["Tab/↑↓/jk", "Space/Enter", "Esc"]) {
      expect(fgCalls).toContainEqual(["accent", key]);
    }
    for (const label of ["move issue", "open", "close"]) {
      expect(fgCalls).toContainEqual(["muted", label]);
    }

    // Opening the issue switches the help to choose/select/close/next wording
    fgCalls.length = 0;
    component.handleInput(keys.enter);
    component.render(80);

    for (const key of ["Tab/↑↓/jk", "Enter", "Space", "Esc"]) {
      expect(fgCalls).toContainEqual(["accent", key]);
    }
    for (const label of ["choose", "select", "close", "next issue"]) {
      expect(fgCalls).toContainEqual(["muted", label]);
    }
  });

  it("closes without changing the preview data when Escape is pressed", () => {
    const preview = createPreview();

    preview.component.handleInput(keys.escape);

    expect(preview.result).toEqual({ cancelled: true, decisions: [] });
  });

  it("shows the category tag on issue lines and omits it when empty", () => {
    const preview = createPreview(60);
    const line = preview.component
      .render(80)
      .find((entry) => entry.includes("1."));
    // Demo item 1 has category "ui"; the tag sits before the priority tag
    expect(line).toContain("[ui] [low]");

    const bare = createPreview(60, [
      {
        id: "no-category",
        title: "Item without category",
        category: "",
        priority: "low",
        recommendation: "",
        impact: "",
        criteria: [],
        actions: ["Fix"],
      },
    ]);
    const bareLine = bare.component
      .render(80)
      .find((entry) => entry.includes("1."));
    expect(bareLine).toContain("Item without category [low]");
    expect(bareLine).not.toContain("[ui]");
  });

  it("keeps a constant full-height frame so the terminal viewport does not jump", () => {
    const preview = createPreview(24);

    // Closed state: short content would otherwise shrink the frame and scroll the buffer
    expect(preview.component.render(80)).toHaveLength(24);

    // Opening an issue grows the content; the frame height must not change
    preview.component.handleInput(keys.space);
    expect(preview.component.render(80)).toHaveLength(24);

    // Esc advances to the next (open) issue; still constant
    preview.component.handleInput(keys.escape);
    expect(preview.component.render(80)).toHaveLength(24);
  });

  it("exits pi on a single Ctrl+C press", () => {
    const preview = createPreview();

    preview.component.handleInput("\u0003");

    expect(preview.onExit).toHaveBeenCalledTimes(1);
    expect(preview.result).toBeUndefined();

    // Further input after the exit request is ignored
    preview.component.handleInput("\u0003");
    expect(preview.onExit).toHaveBeenCalledTimes(1);
  });
});
