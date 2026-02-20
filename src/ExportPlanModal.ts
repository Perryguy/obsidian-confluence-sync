// src/ExportPlanModal.ts
import { App, Modal, Setting, Notice } from "obsidian";
import type { ExportPlanItem, PlanAction } from "./exportPlan";
import { effectiveAction } from "./exportPlan";

export interface ExportReviewContext {
  spaceKey: string;
  parentPageId?: string;
}

export type RebuildPlanFn = (
  ctx: ExportReviewContext,
) => Promise<ExportPlanItem[]>;

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

export class ExportPlanModal extends Modal {
  private items: ExportPlanItem[];
  private onConfirm: (
    selected: ExportPlanItem[],
    ctx: ExportReviewContext,
  ) => Promise<void> | void;

  private ctx: ExportReviewContext;
  private rebuildPlan: RebuildPlanFn;

  constructor(
    app: App,
    initialItems: ExportPlanItem[],
    initialCtx: ExportReviewContext,
    rebuildPlan: RebuildPlanFn,
    onConfirm: (
      selected: ExportPlanItem[],
      ctx: ExportReviewContext,
    ) => Promise<void> | void,
  ) {
    super(app);
    this.items = initialItems;
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
      .setDesc(
        "Paste a Parent Page ID or a Confluence page URL. If set, plan can detect conflicts under this parent.",
      )
      .addText((t) =>
        t
          .setPlaceholder("Page ID or URL")
          .setValue(this.ctx.parentPageId ?? "")
          .onChange((v) => {
            this.ctx.parentPageId = extractPageIdFromInput(v);
          }),
      );

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Rebuild plan")
        .setCta()
        .onClick(async () => {
          try {
            const loading = contentEl.createEl("p", {
              text: "Rebuilding plan…",
            });
            const newItems = await this.rebuildPlan(this.ctx);
            loading.remove();
            this.items = newItems;
            this.render();
          } catch (e: any) {
            console.error(e);
            new Notice(`Failed to rebuild plan: ${e?.message ?? e}`);
          }
        }),
    );

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

      // ✅ Diff button for update/recreate (uses precomputed diffOld/diffNew from planBuilder)
      if ((eff === "update" || eff === "recreate") && item.hasDiff) {
        const diffBtn = details.createEl("button", { text: "Diff" });
        diffBtn.onclick = async () => {
          const { DiffModal } = await import("./diffModal");

          const oldText = item.diffOld ?? "";
          const newText = item.diffNew ?? "";

          new DiffModal(this.app, item.title, oldText, newText).open();
        };
      }

      // Conflict UI (if you have conflict logic in ExportPlanItem)
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
          i.overrideAction = undefined;
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
