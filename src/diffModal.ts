// src/DiffModal.ts
import { App, Modal, Setting } from "obsidian";
import { diffLines } from "diff";

type DiffKind = "add" | "del" | "ctx";

interface DiffLine {
  kind: DiffKind;
  text: string;
}

export class DiffModal extends Modal {
  private showContext = false;
  private contextLines = 3;

  private norm(t: string): string {
    // Normalize line endings to avoid "everything changed" on Windows vs Unix newlines.
    let s = (t ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Optional but helpful: ignore trailing whitespace diffs.
    s = s
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/g, ""))
      .join("\n");

    return s;
  }

  constructor(
    app: App,
    private titleText: string,
    private oldText: string,
    private newText: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: `Diff: ${this.titleText}` });

    // Controls
    new Setting(contentEl)
      .setName("Show context")
      .setDesc(
        "When off, only changed lines (with a small context window) are shown.",
      )
      .addToggle((t) =>
        t.setValue(this.showContext).onChange((v) => {
          this.showContext = v;
          this.render();
        }),
      );

    new Setting(contentEl)
      .setName("Context lines")
      .setDesc("Lines of context around changes (when Show context is off).")
      .addSlider((s) => {
        s.setLimits(0, 20, 1);
        s.setValue(this.contextLines);
        s.onChange((v) => {
          this.contextLines = v;
          this.render();
        });
      });

    contentEl.createEl("hr");

    this.render();
  }

  private render() {
    const { contentEl } = this;

    // Clear any previous diff block (keep header + settings)
    const existing = contentEl.querySelector(".confluence-diff");
    if (existing) existing.remove();

    const wrapper = contentEl.createDiv({ cls: "confluence-diff" });
    const body = wrapper.createDiv({ cls: "confluence-diff-body" });

    const lines = this.buildLines(this.oldText ?? "", this.newText ?? "");
    const display = this.showContext
      ? lines
      : this.withContext(lines, this.contextLines);

    this.renderLines(body, display);
  }

  private buildLines(oldText: string, newText: string): DiffLine[] {
    const oldN = this.norm(oldText);
    const newN = this.norm(newText);

    const parts = diffLines(oldN, newN, { newlineIsToken: true });

    const out: DiffLine[] = [];

    for (const p of parts) {
      const kind: DiffKind = p.added ? "add" : p.removed ? "del" : "ctx";
      const value = p.value ?? "";
      const split = value.split("\n");

      for (let i = 0; i < split.length; i++) {
        const line = split[i];
        if (i === split.length - 1 && line === "") continue; // drop final empty
        out.push({ kind, text: line });
      }
    }

    return out;
  }

  private withContext(lines: DiffLine[], radius: number): DiffLine[] {
    if (radius <= 0) {
      // only changed lines
      return lines.filter((l) => l.kind !== "ctx");
    }

    const keep = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].kind === "add" || lines[i].kind === "del") {
        for (
          let j = Math.max(0, i - radius);
          j <= Math.min(lines.length - 1, i + radius);
          j++
        ) {
          keep.add(j);
        }
      }
    }

    // If there are no changes, show a small message
    if (keep.size === 0) return [{ kind: "ctx", text: "(No differences)" }];

    const out: DiffLine[] = [];
    let lastKept = -2;

    for (let i = 0; i < lines.length; i++) {
      if (!keep.has(i)) continue;

      if (i > lastKept + 1) {
        out.push({ kind: "ctx", text: "…" });
      }

      out.push(lines[i]);
      lastKept = i;
    }

    return out;
  }

  private renderLines(container: HTMLElement, lines: DiffLine[]) {
    for (const l of lines) {
      const row = container.createDiv({ cls: "confluence-diff-row" });

      const prefix = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";

      row.addClass(
        l.kind === "add"
          ? "confluence-diff-added"
          : l.kind === "del"
            ? "confluence-diff-removed"
            : "confluence-diff-context",
      );

      row.createSpan({ cls: "confluence-diff-prefix", text: prefix });

      const text = row.createSpan({ cls: "confluence-diff-text" });
      text.setText(l.text);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
