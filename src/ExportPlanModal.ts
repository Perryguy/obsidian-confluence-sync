import { App, Modal, Setting } from "obsidian";
import type { ExportPlanItem } from "./exportPlan";

export class ExportPlanModal extends Modal {
  private items: ExportPlanItem[];
  private onConfirm: (selected: ExportPlanItem[]) => Promise<void> | void;

  constructor(app: App, items: ExportPlanItem[], onConfirm: (selected: ExportPlanItem[]) => Promise<void> | void) {
    super(app);
    this.items = items;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Review Confluence export" });

    const summary = this.summarize();
    contentEl.createEl("p", {
      text: `Create: ${summary.create}, Update: ${summary.update}, Recreate: ${summary.recreate}, Skip: ${summary.skip}`
    });

    // Bulk actions
    new Setting(contentEl)
      .addButton(b => b.setButtonText("Select all").onClick(() => {
        this.items.forEach(i => (i.selected = i.action !== "skip"));
        this.onOpen(); // rerender (simple)
      }))
      .addButton(b => b.setButtonText("Select none").onClick(() => {
        this.items.forEach(i => (i.selected = false));
        this.onOpen();
      }));

    contentEl.createEl("hr");

    // Item list
    for (const item of this.items) {
      const row = contentEl.createDiv({ cls: "confluence-export-row" });

      // Checkbox + title
      const top = row.createDiv({ cls: "confluence-export-row-top" });

      const cb = top.createEl("input", { type: "checkbox" });
      cb.checked = item.selected;
      cb.disabled = item.action === "skip";
      cb.onchange = () => {
        item.selected = cb.checked;
      };

      top.createEl("span", { text: ` ${item.title}` });

      // Action badge
      top.createEl("span", { text: item.action.toUpperCase(), cls: `confluence-badge confluence-${item.action}` });

      // Details
      const details = row.createDiv({ cls: "confluence-export-row-details" });
      details.createEl("div", { text: `From: ${item.filePath}` });

      const dest = item.pageId
        ? `To: ${item.title} (id=${item.pageId})`
        : `To: ${item.title}`;

      details.createEl("div", { text: dest });

      details.createEl("div", { text: `Why: ${item.reason}`, cls: "confluence-muted" });

      if (item.webui) {
        const a = details.createEl("a", { text: "Open in Confluence", href: item.webui });
        a.target = "_blank";
        a.rel = "noopener";
      }

      row.createEl("hr");
    }

    // Footer buttons
    const footer = contentEl.createDiv({ cls: "confluence-export-footer" });

    const exportBtn = footer.createEl("button", { text: "Export selected", cls: "mod-cta" });
    exportBtn.onclick = async () => {
      const selected = this.items.filter(i => i.selected && i.action !== "skip");
      this.close();
      await this.onConfirm(selected);
    };

    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }

  private summarize() {
    const s = { create: 0, update: 0, recreate: 0, skip: 0 };
    for (const i of this.items) s[i.action]++;
    return s;
  }
}