// src/ExportPlanModal.ts
import { App, Modal, Setting, Notice } from "obsidian";
import type { ExportPlanItem, PlanAction } from "./exportPlan";
import { effectiveAction } from "./exportPlan";
import type { HierarchyMode, ManyToManyPolicy } from "./types";

export interface ExportReviewContext {
  spaceKey: string;
  parentPageId?: string;

  // ✅ per-export hierarchy choices
  hierarchyMode: HierarchyMode;
  hierarchyManyToManyPolicy: ManyToManyPolicy;
}

export type RebuildPlanFn = (
  ctx: ExportReviewContext,
) => Promise<{ items: ExportPlanItem[]; hierarchyPreviewLines: string[] }>;

function extractPageIdFromInput(raw: string): string | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;

  if (/^\d+$/.test(s)) return s;

  const m1 = s.match(/\/pages\/(\d+)\b/);
  if (m1?.[1]) return m1[1];

  const m2 = s.match(/[?&]pageId=(\d+)\b/);
  if (m2?.[1]) return m2[1];

  const m3 = s.match(/\/content\/(\d+)\b/);
  if (m3?.[1]) return m3[1];

  const m4 = s.match(/\b(\d{6,})\b/);
  if (m4?.[1]) return m4[1];

  return undefined;
}

function fmtLabelDelta(add?: string[], remove?: string[]): string {
  const a = add?.length ?? 0;
  const r = remove?.length ?? 0;
  if (a === 0 && r === 0) return "Labels unchanged";
  if (a > 0 && r > 0) return `Labels changed (+${a} / -${r})`;
  if (a > 0) return `Labels changed (+${a})`;
  return `Labels changed (-${r})`;
}

function labelsOnlyUpdateHeuristic(item: ExportPlanItem): boolean {
  // We don’t have a first-class "contentChanged" flag in the item shape,
  // so we use the planBuilder reason text as the indicator.
  // Your planBuilder sets: "Labels changed (tag-only change)."
  const reason = (item.reason ?? "").toLowerCase();
  return (
    !!item.labelsChanged &&
    reason.includes("labels changed") &&
    item.titleChanged !== true
  );
}

export class ExportPlanModal extends Modal {
  private items: ExportPlanItem[];
  private hierarchyPreviewLines: string[] = [];

  private onConfirm: (
    selected: ExportPlanItem[],
    ctx: ExportReviewContext,
  ) => Promise<void> | void;

  private ctx: ExportReviewContext;
  private rebuildPlan: RebuildPlanFn;

  constructor(
    app: App,
    initial: { items: ExportPlanItem[]; hierarchyPreviewLines: string[] },
    initialCtx: ExportReviewContext,
    rebuildPlan: RebuildPlanFn,
    onConfirm: (
      selected: ExportPlanItem[],
      ctx: ExportReviewContext,
    ) => Promise<void> | void,
  ) {
    super(app);
    this.items = initial.items;
    this.hierarchyPreviewLines = initial.hierarchyPreviewLines ?? [];
    this.ctx = { ...initialCtx };
    this.rebuildPlan = rebuildPlan;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Review Confluence export" });

    // ---------- Export Context ----------
    contentEl.createEl("h3", { text: "Target" });

    new Setting(contentEl)
      .setName("Space Key")
      .setDesc("The Confluence space key (e.g. ENG).")
      .addText((t) =>
        t
          .setPlaceholder("e.g. ENG")
          .setValue(this.ctx.spaceKey ?? "")
          .onChange((v) => {
            this.ctx.spaceKey = v.trim().toUpperCase();
          }),
      );

    new Setting(contentEl)
      .setName("Parent Page (optional)")
      .setDesc("Paste a Parent Page ID or a Confluence page URL.")
      .addText((t) =>
        t
          .setPlaceholder("Page ID or URL")
          .setValue(this.ctx.parentPageId ?? "")
          .onChange((v) => {
            this.ctx.parentPageId = extractPageIdFromInput(v);
          }),
      );

    contentEl.createEl("hr");

    // ---------- Hierarchy ----------
    contentEl.createEl("h3", { text: "Hierarchy (optional)" });

    new Setting(contentEl)
      .setName("Hierarchy mode")
      .setDesc("How child pages should be organised under the root.")
      .addDropdown((d) => {
        d.addOption("flat", "Flat (current behaviour)");
        d.addOption("links", "Links (first linked page becomes parent)");
        d.addOption("folder", "Folder (index.md / folder name note)");
        d.addOption("frontmatter", "Frontmatter (parent: ...)");
        d.addOption("hybrid", "Hybrid (folder, then links)");
        d.setValue(this.ctx.hierarchyMode);
        d.onChange((v) => {
          this.ctx.hierarchyMode = v as HierarchyMode;
        });
      });

    new Setting(contentEl)
      .setName("Many-to-many policy")
      .setDesc(
        "When a note could belong under multiple parents, choose a deterministic policy.",
      )
      .addDropdown((d) => {
        d.addOption("firstSeen", "First seen");
        d.addOption("closestToRoot", "Closest to root");
        d.addOption("preferFolderIndex", "Prefer folder index");
        d.setValue(this.ctx.hierarchyManyToManyPolicy);
        d.onChange((v) => {
          this.ctx.hierarchyManyToManyPolicy = v as ManyToManyPolicy;
        });
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Rebuild plan")
        .setCta()
        .onClick(async () => {
          try {
            const loading = contentEl.createEl("p", {
              text: "Rebuilding plan…",
            });

            const next = await this.rebuildPlan(this.ctx);
            loading.remove();

            this.items = next.items;
            this.hierarchyPreviewLines = next.hierarchyPreviewLines ?? [];
            this.render();
          } catch (e: any) {
            console.error(e);
            new Notice(`Failed to rebuild plan: ${e?.message ?? e}`);
          }
        }),
    );

    // Preview
    if (this.hierarchyPreviewLines.length > 0) {
      const box = contentEl.createDiv({ cls: "confluence-hierarchy-preview" });
      box.createEl("div", { text: "Preview:", cls: "confluence-muted" });

      const pre = box.createEl("pre", { cls: "confluence-pre" });
      pre.setText(this.hierarchyPreviewLines.join("\n"));
    }

    contentEl.createEl("hr");

    // ---------- Summary ----------
    const summary = this.summarize();
    contentEl.createEl("p", {
      text:
        `Create: ${summary.create}, Update: ${summary.update}, ` +
        `Recreate: ${summary.recreate}, Conflict: ${summary.conflict}, Skip: ${summary.skip}`,
    });

    // Bulk actions
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Select all").onClick(() => {
          this.items.forEach((i) => {
            const a = effectiveAction(i);
            i.selected = a !== "skip" && a !== "conflict";
          });
          this.render();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Select none").onClick(() => {
          this.items.forEach((i) => (i.selected = false));
          this.render();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Select creates").onClick(() => {
          this.items.forEach(
            (i) => (i.selected = effectiveAction(i) === "create"),
          );
          this.render();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Select updates").onClick(() => {
          this.items.forEach(
            (i) => (i.selected = effectiveAction(i) === "update"),
          );
          this.render();
        }),
      );

    contentEl.createEl("hr");

    // ---------- Items ----------
    for (const item of this.items) {
      const row = contentEl.createDiv({ cls: "confluence-export-row" });
      const top = row.createDiv({ cls: "confluence-export-row-top" });

      const cb = top.createEl("input", { type: "checkbox" });
      cb.checked = item.selected;

      const eff = effectiveAction(item);
      cb.disabled = eff === "skip" || eff === "conflict";

      cb.onchange = () => {
        item.selected = cb.checked;
      };

      top.createEl("span", { text: ` ${item.title}` });

      top.createEl("span", {
        text: eff.toUpperCase(),
        cls: `confluence-badge confluence-${eff}`,
      });

      const details = row.createDiv({ cls: "confluence-export-row-details" });
      details.createEl("div", { text: `From: ${item.filePath}` });

      if (item.pageId)
        details.createEl("div", { text: `Target pageId: ${item.pageId}` });

      if (item.webui) {
        const a = details.createEl("a", {
          text: "Open target in Confluence",
          href: item.webui,
        });
        a.target = "_blank";
        a.rel = "noopener";
      }

      // ---- Labels UI (NEW) ----
      const labelsChanged = !!item.labelsChanged;
      const add = item.labelsToAdd ?? [];
      const remove = item.labelsToRemove ?? [];

      // Show a compact line only when we have label info (or label changes)
      if (labelsChanged || (item.labelsDesired?.length ?? 0) > 0) {
        details.createEl("div", {
          text: fmtLabelDelta(add, remove),
          cls: labelsChanged ? "confluence-muted" : "confluence-muted",
        });

        // Toggle: Apply label changes
        // Default ON unless explicitly set false
        if (item.applyLabelChanges === undefined) item.applyLabelChanges = true;

        const isLabelsOnly = labelsOnlyUpdateHeuristic(item);

        new Setting(details)
          .setName("Apply label changes")
          .setDesc(
            isLabelsOnly
              ? "If off, this becomes a skip (labels-only update)."
              : "If off, page content/title may still update but labels won't change.",
          )
          .addToggle((t) => {
            t.setValue(item.applyLabelChanges !== false);
            t.onChange((v) => {
              item.applyLabelChanges = v;

              // If this item is an update ONLY because of labels, allow the toggle to convert it to skip.
              if (!v && isLabelsOnly && item.action === "update") {
                item.overrideAction = "skip";
                item.selected = false;
              } else if (v && item.overrideAction === "skip" && isLabelsOnly) {
                // Restore default planned action
                item.overrideAction = undefined;
                item.selected = true;
              }

              this.render();
            });
          });

        // Show detailed add/remove lists if they exist
        if (add.length > 0) {
          const d = details.createDiv({ cls: "confluence-muted" });
          d.createEl("div", { text: `Add labels: ${add.join(", ")}` });
        }
        if (remove.length > 0) {
          const d = details.createDiv({ cls: "confluence-muted" });
          d.createEl("div", { text: `Remove labels: ${remove.join(", ")}` });
        }
      }

      if ((eff === "update" || eff === "recreate") && item.hasDiff) {
        const diffBtn = details.createEl("button", { text: "Diff" });
        diffBtn.onclick = async () => {
          const { DiffModal } = await import("./diffModal");

          const oldText = item.diffOld ?? "";
          const newText = item.diffNew ?? "";

          new DiffModal(this.app, item.title, oldText, newText).open();
        };
      }

      if (eff === "conflict") {
        details.createEl("div", {
          text: "Conflict detected:",
          cls: "confluence-muted",
        });

        if (item.conflictPageId) {
          details.createEl("div", {
            text: `Existing pageId: ${item.conflictPageId}`,
          });
        }

        if (item.conflictWebui) {
          const a2 = details.createEl("a", {
            text: "Open conflicting page",
            href: item.conflictWebui,
          });
          a2.target = "_blank";
          a2.rel = "noopener";
        }

        new Setting(details)
          .setName("Resolve conflict")
          .setDesc("Choose what to do for this item.")
          .addDropdown((d) => {
            d.addOption("", "Default (Conflict → not exported)");
            d.addOption("skip", "Skip");
            d.addOption("update", "Update existing page (in place)");
            d.addOption("create", "Create anyway (may duplicate title)");
            d.setValue(item.overrideAction ?? "");
            d.onChange((v) => {
              item.overrideAction = (v || undefined) as PlanAction | undefined;
              const eff2 = effectiveAction(item);
              item.selected = eff2 !== "skip" && eff2 !== "conflict";
              this.render();
            });
          });
      }

      details.createEl("div", {
        text: `Why: ${item.reason}`,
        cls: "confluence-muted",
      });

      row.createEl("hr");
    }

    // ---------- Footer ----------
    const footer = contentEl.createDiv({ cls: "confluence-export-footer" });

    const exportBtn = footer.createEl("button", {
      text: "Export selected",
      cls: "mod-cta",
    });

    exportBtn.onclick = async () => {
      const selected = this.items
        .filter((i) => i.selected)
        .map((i) => {
          i.action = effectiveAction(i);
          // Leave overrideAction in place (it matters: skip vs update)
          return i;
        })
        .filter((i) => i.action !== "skip" && i.action !== "conflict");

      this.close();
      await this.onConfirm(selected, this.ctx);
    };

    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();
  }

  private summarize() {
    const s = { create: 0, update: 0, recreate: 0, conflict: 0, skip: 0 };
    for (const i of this.items) {
      const a = effectiveAction(i);
      (s as any)[a] = ((s as any)[a] ?? 0) + 1;
    }
    return s;
  }
}