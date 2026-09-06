import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  matchesKey,
  type Component,
  type EditorTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ReviewDecisionPreviewItem } from "../src/reviewDecisionItems";

export type { ReviewDecisionPreviewItem };

export interface ReviewDecisionPreviewDecision {
  id: string;
  value: string;
  type: "preset" | "custom";
}

export interface ReviewDecisionPreviewResult {
  cancelled: boolean;
  decisions: ReviewDecisionPreviewDecision[];
}

export const PREVIEW_DECISION_ITEMS: readonly ReviewDecisionPreviewItem[] = [
  {
    id: "long-user-name",
    title: "Long user names overflow the admin list",
    category: "ui",
    priority: "low",
    recommendation: "Postpone is acceptable for this release.",
    impact: "Only the admin display is affected. Data and actions continue to work.",
    criteria: [
      "The full name is available on the detail screen.",
      "The issue only occurs for names longer than 30 characters.",
      "There is no security or data-integrity impact.",
    ],
    actions: [
      "Fix in this release",
      "Postpone",
      "Investigate further",
    ],
  },
  {
    id: "payment-failure-message",
    title: "Payment failures do not explain the next step",
    category: "payments",
    priority: "high",
    recommendation: "Fixing this release is recommended.",
    impact: "Users may be unable to complete a purchase without contacting support.",
    criteria: [
      "The failure frequency is known and within an accepted range.",
      "Another screen explains how to retry the payment.",
      "Support and purchase-dropoff impact are acceptable.",
    ],
    actions: [
      "Fix in this release",
      "Postpone",
      "Investigate failure frequency",
    ],
  },
];

type PreviewView = "issues" | "input";

const PRIORITY_LABELS: Record<ReviewDecisionPreviewItem["priority"], string> = {
  high: "high",
  medium: "medium",
  low: "low",
};

export class ReviewDecisionPreviewComponent implements Component {
  private readonly editor: Editor;
  private readonly expanded = new Set<string>();
  private readonly decisions = new Map<string, ReviewDecisionPreviewDecision>();
  private view: PreviewView = "issues";
  private selectedIssue = 0;
  private selectedAction = 0;
  private inputError: string | undefined;
  private scrollTop = 0;
  private scrollableViewportHeight = 1;
  private scrollToActionHeading = false;
  private closed = false;

  constructor(
    private readonly items: readonly ReviewDecisionPreviewItem[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (result: ReviewDecisionPreviewResult) => void,
    private readonly onExit: () => void,
  ) {
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme);
    this.editor.onSubmit = (value) => this.submitCustomDecision(value);
  }

  handleInput(data: string): void {
    if (this.closed) return;

    // 決定画面にはクリア対象のエディタ内容がないため、単発の Ctrl+C で Pi を終了する
    if (matchesKey(data, "ctrl+c")) {
      this.exitPi();
      return;
    }

    // Tab/↑↓/jk: 閉じている間は issue 選択、open 中はアクション選択肢の移動
    if (this.view !== "input") {
      if (
        matchesKey(data, Key.tab) ||
        matchesKey(data, Key.down) ||
        matchesKey(data, "j")
      ) {
        this.moveNext();
        return;
      }
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.movePrevious();
        return;
      }
    }

    if (this.view === "input") {
      if (matchesKey(data, Key.escape)) {
        this.view = "issues";
        this.inputError = undefined;
        this.editor.setText("");
        this.editor.focused = false;
        this.scrollToActionHeading = true;
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    this.handleIssueInput(data);
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const lines: string[] = [];

    const header = this.renderHeader();
    const content = this.renderContent(renderWidth);
    const footer = this.renderFooter(renderWidth);
    const viewportHeight = this.getViewportHeight();
    this.scrollableViewportHeight = Math.max(
      0,
      viewportHeight - header.length - footer.length,
    );
    const maxScrollTop = Math.max(
      0,
      content.length - this.scrollableViewportHeight,
    );
    this.scrollTop = Math.min(this.scrollTop, maxScrollTop);
    if (this.scrollToActionHeading) {
      // 開いた直後はアクション一覧を可視領域の先頭付近へ揃える
      this.scrollToActionHeading = false;
      const heading = content.findIndex((line) =>
        line.includes("Choose an action"),
      );
      if (heading !== -1) {
        this.scrollTop = Math.min(heading, maxScrollTop);
      }
    }
    const visibleContent = content.slice(
      this.scrollTop,
      this.scrollTop + this.scrollableViewportHeight,
    );
    // 出力行数を常に端末全高に固定する。main-screen モードではコンポーネントの行数分だけ
    // 画面バッファが伸び縮みするため、開閉で高さが変わるとビューポート全体がスクロールし、
    // clearOnShrink 時には全クリア再描画も発生してちらつく。
    while (visibleContent.length < this.scrollableViewportHeight) {
      visibleContent.push("");
    }
    lines.push(...header, ...visibleContent, ...footer);
    return lines.map((line) => truncateToWidth(line, renderWidth));
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private handleIssueInput(data: string): void {
    const open = this.expanded.has(this.currentItem().id);
    if (matchesKey(data, Key.space)) {
      // Space は issue を開閉する（閉じた場合はその項目に留まる）
      if (open) {
        this.expanded.delete(this.currentItem().id);
        this.refresh();
      } else {
        this.openCurrentItem();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (!open) {
        this.openCurrentItem();
        return;
      }
      // open 中: 選択したアクションを確定する（Custom decision は入力画面を開く）
      if (this.selectedAction === this.currentItem().actions.length) {
        this.openCustomInput();
        return;
      }
      this.confirmPresetDecision();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (open) {
        // Esc はこの issue を閉じて次の issue を開く
        this.advanceToNextIssue();
        return;
      }
      this.close(true);
    }
  }

  // アクション選択肢のハイライトを移動する（決定は記録しない）
  private moveActionSelection(direction: -1 | 1): void {
    const actionCount = this.currentItem().actions.length + 1;
    this.selectedAction = Math.min(
      actionCount - 1,
      Math.max(0, this.selectedAction + direction),
    );
    this.refresh();
  }

  // 現在の項目を開く: アクション選択肢をアクティブにする（決定はしない）
  private openCurrentItem(): void {
    const item = this.currentItem();
    if (this.expanded.has(item.id)) return;
    this.expanded.add(item.id);
    // 決定済みの項目は既存の選択位置をアクティブにして開き、そのまま変更できるようにする
    this.selectedAction = this.initialActionIndex();
    this.scrollToActionHeading = true;
    this.refresh();
  }

  // ハイライトされた preset アクションを決定として確定し、この項目を閉じて次の項目を開く
  private confirmPresetDecision(): void {
    const item = this.currentItem();
    this.decisions.set(item.id, {
      id: item.id,
      value: item.actions[this.selectedAction],
      type: "preset",
    });
    if (this.finishIfAllDecided()) return;
    this.advanceToNextIssue();
  }

  // 全項目の決定が揃ったらプレビューを自動終了して決定を返す
  private finishIfAllDecided(): boolean {
    if (this.decisions.size < this.items.length) return false;
    this.close(false);
    return true;
  }

  // 現在の項目を閉じて次の項目を開く（wrap 付き）
  private advanceToNextIssue(): void {
    this.view = "issues";
    this.inputError = undefined;
    this.selectIssue((this.selectedIssue + 1) % this.items.length);
    this.openCurrentItem();
  }

  // 閉じている間は次の項目へ、open 中は次のアクションへ（wrap 付き）
  private moveNext(): void {
    if (this.expanded.has(this.currentItem().id)) {
      this.moveActionSelection(1);
      return;
    }
    this.selectIssue((this.selectedIssue + 1) % this.items.length);
    this.refresh();
  }

  // 閉じている間は前の項目へ、open 中は前のアクションへ（wrap 付き）
  private movePrevious(): void {
    if (this.expanded.has(this.currentItem().id)) {
      this.moveActionSelection(-1);
      return;
    }
    this.selectIssue(
      (this.selectedIssue - 1 + this.items.length) % this.items.length,
    );
    this.refresh();
  }

  private openCustomInput(): void {
    this.view = "input";
    this.inputError = undefined;
    // 過去の custom 決定があれば下書きとして再利用し、修正できるようにする
    const existing = this.decisions.get(this.currentItem().id);
    this.editor.setText(existing?.type === "custom" ? existing.value : "");
    this.editor.focused = true;
    this.scrollToBottom();
    this.refresh();
  }

  private submitCustomDecision(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) {
      this.inputError = "Enter a decision before confirming.";
      this.refresh();
      return;
    }
    this.editor.focused = false;
    this.decisions.set(this.currentItem().id, {
      id: this.currentItem().id,
      value: trimmed,
      type: "custom",
    });
    if (this.finishIfAllDecided()) return;
    this.advanceToNextIssue();
  }

  private renderIssueList(lines: string[], width: number): void {
    for (const [index, item] of this.items.entries()) {
      const selected = index === this.selectedIssue;
      const isExpanded = this.expanded.has(item.id);
      const decision = this.decisions.get(item.id);
      const cursor = selected ? this.theme.fg("accent", "> ") : "  ";
      const marker = decision
        ? this.theme.fg("success", "✓")
        : this.theme.fg("muted", "○");
      const arrow = isExpanded ? "▼" : "▶";
      const priority = this.theme.fg(
        item.priority === "high" ? "warning" : "dim",
        `[${PRIORITY_LABELS[item.priority]}]`,
      );
      // category が無いモデル出力でも表示を崩さないため、タグは任意
      const category = item.category
        ? ` ${this.theme.fg("muted", `[${item.category}]`)}`
        : "";
      const title = selected
        ? this.theme.fg("accent", item.title)
        : this.theme.fg("text", item.title);
      this.addWrapped(lines, `${cursor}${marker} ${arrow} ${index + 1}. ${title}${category} ${priority}`, width);

      if (selected && isExpanded) {
        this.renderDetails(lines, item, width);
        this.renderActions(lines, item, width);
      }
      if (decision) {
        this.addWrapped(
          lines,
          this.theme.fg("success", `  Decision: ${decision.value}`),
          width,
          "  ",
        );
      }
      lines.push("");
    }
  }

  private renderInputView(lines: string[], width: number): void {
    const item = this.currentItem();
    this.addWrapped(
      lines,
      this.theme.fg(
        "muted",
        `Issue ${this.selectedIssue + 1}/${this.items.length}`,
      ),
      width,
      "  ",
    );
    lines.push("");
    const categoryTag = item.category
      ? ` ${this.theme.fg("muted", `[${item.category}]`)}`
      : "";
    this.addWrapped(
      lines,
      this.theme.fg("accent", `▼ ${item.title}`) + categoryTag,
      width,
      "  ",
    );
    this.renderSection(lines, "Recommendation", item.recommendation, width);
    this.renderSection(lines, "Impact", item.impact, width);
    lines.push("");
    this.addWrapped(
      lines,
      this.theme.bold(this.theme.fg("text", "Custom decision")),
      width,
      "  ",
    );
    lines.push("");
    for (const line of this.editor.render(Math.max(1, width - 2))) {
      lines.push(truncateToWidth(`  ${line}`, width));
    }
    if (this.inputError) {
      lines.push("");
      this.addWrapped(
        lines,
        this.theme.fg("warning", this.inputError),
        width,
        "  ",
      );
    }
  }

  private renderDetails(
    lines: string[],
    item: ReviewDecisionPreviewItem,
    width: number,
  ): void {
    this.renderSection(lines, "Recommendation", item.recommendation, width);
    this.renderSection(lines, "Impact", item.impact, width);
    this.renderSection(lines, "Decision criteria", item.criteria, width);
  }

  private renderActions(
    lines: string[],
    item: ReviewDecisionPreviewItem,
    width: number,
  ): void {
    lines.push("");
    // セクション見出し（Recommendation 等）と同じ 4 スペース字下げで揃える
    this.addWrapped(
      lines,
      // 選択待ちであることを示す warning 色で見出しを表示する
      this.theme.bold(this.theme.fg("warning", "Choose an action")),
      width,
      "    ",
    );
    // 見出しの下に揃える: カーソルは 4 スペース、選択肢テキストは 6 スペースで整列
    const actions = [...item.actions, "Custom decision"];
    for (const [index, action] of actions.entries()) {
      const selected = index === this.selectedAction;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      // アクティブな選択肢は accent 色で強調する
      const label = selected ? this.theme.fg("accent", action) : action;
      this.addWrapped(lines, `${prefix}${label}`, width, "    ");
    }
  }

  private renderSection(
    lines: string[],
    label: string,
    value: string | readonly string[],
    width: number,
  ): void {
    lines.push("");
    this.addWrapped(
      lines,
      this.theme.bold(this.theme.fg("muted", label)),
      width,
      "    ",
    );
    // 値が空のセクション（recommendation / impact 欠落時）は描画しない
    const values = typeof value === "string" ? (value ? [value] : []) : value;
    if (values.length === 0) return;
    for (const entry of values) {
      this.addWrapped(lines, `• ${entry}`, width, "    ");
    }
  }

  // ヘルプは [キー, 操作] の組で描画: キーは accent、説明は muted で区別する
  private renderHelp(): string {
    const open = this.expanded.has(this.currentItem().id);
    const segments: [string, string][] =
      this.view === "input"
        ? [
            ["Enter", "confirm"],
            ["Esc", "back"],
          ]
        : open
          ? [
              ["Tab/↑↓/jk", "choose"],
              ["Enter", "select"],
              ["Space", "close"],
              ["Esc", "next issue"],
            ]
          : [
              ["Tab/↑↓/jk", "move issue"],
              ["Space/Enter", "open"],
              ["Esc", "close"],
            ];
    return segments
      .map(
        ([key, label]) =>
          `${this.theme.fg("accent", key)} ${this.theme.fg("muted", label)}`,
      )
      .join("   ");
  }

  private renderHeader(): string[] {
    return [
      this.theme.bold(this.theme.fg("accent", "User decisions required")),
      this.theme.fg(
        "muted",
        `${this.decisions.size}/${this.items.length} decided`,
      ),
      "",
    ];
  }

  private renderContent(width: number): string[] {
    const lines: string[] = [];
    if (this.view === "input") {
      this.renderInputView(lines, width);
    } else {
      this.renderIssueList(lines, width);
    }
    return lines;
  }

  private renderFooter(width: number): string[] {
    const lines: string[] = [""];
    this.addWrapped(lines, this.renderHelp(), width, "  ");
    return lines;
  }

  private getViewportHeight(): number {
    // pi 内蔵セレクタ（tree selector 等）と同様に端末全行数をビューポートにする。
    // render() がこの高さで空白パディングするため、UI 表示中はフレーム高が一定になる
    return Math.max(1, this.tui.terminal.rows);
  }

  // 決定操作部（custom エディタ）を可視領域の下端に揃える。
  // 大きな値を設定すると render() が最大スクロール位置へ丸め込む
  private scrollToBottom(): void {
    this.scrollTop = Number.MAX_SAFE_INTEGER;
  }

  private addWrapped(
    lines: string[],
    text: string,
    width: number,
    prefix = "",
  ): void {
    const prefixWidth = visibleWidth(prefix);
    const availableWidth = Math.max(1, width - prefixWidth);
    const wrapped = wrapTextWithAnsi(text, availableWidth);
    const continuation = " ".repeat(prefixWidth);
    for (const [index, entry] of wrapped.entries()) {
      lines.push(
        truncateToWidth(
          `${index === 0 ? prefix : continuation}${entry}`,
          width,
        ),
      );
    }
  }

  // 選択が別の項目に移るときの切替（前の項目は折りたたんで矢印を右向きに戻す）
  private selectIssue(index: number): void {
    if (index === this.selectedIssue) return;
    this.expanded.delete(this.currentItem().id);
    this.selectedIssue = index;
  }

  private currentItem(): ReviewDecisionPreviewItem {
    return this.items[this.selectedIssue];
  }

  // 決定済み項目のアクション選択初期位置（未決定は先頭、custom は Custom decision）
  private initialActionIndex(): number {
    const item = this.currentItem();
    const decision = this.decisions.get(item.id);
    if (!decision) return 0;
    if (decision.type === "custom") return item.actions.length;
    const index = item.actions.indexOf(decision.value);
    return index === -1 ? 0 : index;
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private close(cancelled: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.done({
      cancelled,
      decisions: Array.from(this.decisions.values()),
    });
  }

  // UI を閉じ、終了処理を呼び出し側の onExit 委譲する
  private exitPi(): void {
    if (this.closed) return;
    this.closed = true;
    this.onExit();
  }
}
