import { Plugin, Notice } from "obsidian";
import type { ConfluenceSettings } from "./types";
import { ConfluenceSettingTab, DEFAULT_SETTINGS } from "./settings";
import { ConfluenceClient } from "./confluenceClient";
import { MappingService } from "./mapping";
import { Exporter } from "./exporter";
import { ExportPlanModal } from "./ExportPlanModal";
import { buildExportPlan } from "./planBuilder";
import type { TFile } from "obsidian";

export default class ConfluenceSyncPlugin extends Plugin {
  settings: ConfluenceSettings = DEFAULT_SETTINGS;

  client!: ConfluenceClient;
  mapping!: MappingService;
  exporter!: Exporter;

  private statusEl?: HTMLElement;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new ConfluenceSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("Confluence: idle");

    // ✅ init shared services once
    this.rebuildServices();

    this.addCommand({
      id: "confluence-sync-test-connection",
      name: "Confluence Sync: Test connection",
      callback: async () => {
        try {
          // ensure latest settings
          this.rebuildServices();
          const root = await this.client.ping();
          new Notice(`Confluence OK. REST root: ${root}`);
        } catch (e: any) {
          console.error(e);
          new Notice(`Confluence failed: ${e?.message ?? e}`);
        }
      },
    });

    this.addCommand({
      id: "confluence-sync-reset-mapping",
      name: "Confluence Sync: Reset mapping file",
      callback: async () => {
        try {
          // ensure mapping exists
          if (!this.mapping) this.rebuildServices();

          await this.mapping.load();
          await this.mapping.reset();
          new Notice("Confluence mapping reset. Next export will recreate pages.");
        } catch (e: any) {
          console.error(e);
          new Notice(`Reset failed: ${e?.message ?? e}`);
        }
      },
    });

    // ✅ Review-first export
    this.addCommand({
      id: "confluence-export-review",
      name: "Export to Confluence (Review…)",
      callback: async () => {
        const root = this.app.workspace.getActiveFile() as TFile | null;
        if (!root) {
          new Notice("Open a note to export.");
          return;
        }
        if (!this.settings.spaceKey) {
          new Notice("Set Space Key in plugin settings first.");
          return;
        }

        try {
          this.rebuildServices();

          // 1) collect export set (no export yet)
          const filesToExport = await this.exporter.collectExportSet(root);
          if (filesToExport.length === 0) {
            new Notice("Nothing to export.");
            return;
          }

          // 2) build plan (create/update/recreate/skip)
          const plan = await buildExportPlan(
            {
              app: this.app,
              client: this.client,
              mapping: this.mapping,
              settings: {
                spaceKey: this.settings.spaceKey,
                updateExisting: this.settings.updateExisting,
              },
            },
            filesToExport,
          );

          // 3) show modal and export selected subset
          new ExportPlanModal(this.app, plan, async (selectedItems) => {
            const selectedPaths = new Set(selectedItems.map((i) => i.filePath));
            await this.exporter.exportFromRootSelected(root, selectedPaths);
          }).open();
        } catch (e: any) {
          console.error(e);
          new Notice(`Export failed: ${e?.message ?? e}`);
          this.statusEl?.setText("Confluence: error");
        } finally {
          this.statusEl?.setText("Confluence: idle");
        }
      },
    });

    // Existing "export now" command (no review)
    this.addCommand({
      id: "confluence-sync-export-linked-set",
      name: "Confluence Sync: Export current + linked set",
      callback: async () => {
        try {
          const file = this.app.workspace.getActiveFile();
          if (!file) {
            new Notice("No active note.");
            return;
          }
          if (!this.settings.spaceKey) {
            new Notice("Set Space Key in plugin settings first.");
            return;
          }

          this.rebuildServices();

          try {
            await this.exporter.exportFromRoot(file);
            this.statusEl?.setText("Confluence: idle");
          } catch (e) {
            this.statusEl?.setText("Confluence: error");
            throw e;
          }
        } catch (e: any) {
          console.error(e);
          new Notice(`Export failed: ${e?.message ?? e}`);
        }
      },
    });
  }

  private rebuildServices() {
    // Always rebuild client/exporter to reflect latest settings
    this.client = new ConfluenceClient({
      baseUrl: this.settings.baseUrl,
      mode: this.settings.mode,
      authMode: this.settings.authMode,
      username: this.settings.username,
      passwordOrToken: this.settings.passwordOrToken,
      bearerToken: this.settings.bearerToken,
      restApiPathOverride: this.settings.restApiPathOverride,
    });

    this.mapping = new MappingService(this.app, this.settings.mappingFileName);

    this.exporter = new Exporter(
      this.app,
      this.settings,
      this.client,
      this.mapping,
      (text: string) => this.statusEl?.setText(text),
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Apply changes immediately
    this.rebuildServices();
  }
}
