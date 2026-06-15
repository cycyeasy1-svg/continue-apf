import { EXTENSION_NAME } from "core/util/constants";
import * as vscode from "vscode";

const SHOW_DELAY_MS = 400;
const INDICATOR_TEXT = "✨ 思考中...";

/**
 * Shows a subtle "✨ 思考中..." hint at the cursor while an autocomplete request
 * is in flight, so users can tell the request was triggered even when the model
 * is slow to respond (e.g. behind a corporate proxy).
 *
 * The indicator is deferred by SHOW_DELAY_MS: fast completions never show it,
 * only genuinely slow ones do. Display/clear follows the autocomplete request
 * lifecycle — show() on request start, hide() when it ends.
 */
export class ThinkingIndicator {
  private static instance: ThinkingIndicator;

  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: INDICATOR_TEXT,
      color: "#888",
      fontStyle: "italic",
    },
  });

  private showTimer: NodeJS.Timeout | undefined;

  private constructor() {}

  public static getInstance(): ThinkingIndicator {
    if (!ThinkingIndicator.instance) {
      ThinkingIndicator.instance = new ThinkingIndicator();
    }
    return ThinkingIndicator.instance;
  }

  private isEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration(EXTENSION_NAME)
        .get<boolean>("showThinkingIndicator") ?? true
    );
  }

  /**
   * Called when an autocomplete request starts. Renders the indicator after
   * SHOW_DELAY_MS — if the request finishes (or is cancelled) before then,
   * hide() cancels the timer and the indicator never appears. This keeps fast
   * completions distraction-free while still surfacing slow ones.
   */
  public show(editor: vscode.TextEditor, position: vscode.Position) {
    if (!this.isEnabled()) {
      return;
    }

    // Reset any pending indicator from a prior request so the newest cursor
    // position wins and timers never stack up across rapid keystrokes.
    this.clearTimer();
    this.clearDecoration();

    this.showTimer = setTimeout(() => {
      this.showTimer = undefined;
      try {
        const range = new vscode.Range(position, position);
        editor.setDecorations(this.decoration, [{ range }]);
      } catch {
        // Editor may have been closed between show() and the timer firing.
      }
    }, SHOW_DELAY_MS);
  }

  /** Called when an autocomplete request ends (success / cancel / error). */
  public hide() {
    this.clearTimer();
    this.clearDecoration();
  }

  private clearDecoration() {
    for (const editor of vscode.window.visibleTextEditors) {
      try {
        editor.setDecorations(this.decoration, []);
      } catch {
        // Editor may have been disposed; safe to ignore.
      }
    }
  }

  private clearTimer() {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = undefined;
    }
  }

  public dispose() {
    this.clearTimer();
    this.clearDecoration();
    this.decoration.dispose();
  }
}
