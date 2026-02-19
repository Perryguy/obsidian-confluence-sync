// src/main.ts
import { Plugin, Notice, type TFile } from "obsidian";
import type { ConfluenceSettings } from "./types";
import { ConfluenceSettingTab, DEFAULT_SETTINGS } from "./settings";
import { ConfluenceClient } from "./confluenceClient";
import { MappingService } from "./mapping";
import { Exporter } from "./exporter";
import { ExportPlanModal } from "./ExportPlanModal";
import { buildExportPlan } from "./planBuilder";

export default class ConfluenceSyncPlugin extends Plugin {
  settings: ConfluenceSettings = DEFAULT_SETTINGS;

  client!: ConfluenceClient;
  mapping!: MappingService;
  exporter!: Exporter;

  private statusEl?: HTMLElement;

  async onload() {
    // -----------------------------
    // Load plugin data (settings + mapping)
    // Back-compat: older builds stored settings at root.
    // -----------------------------
    const raw = (await this.loadData()) ?? {};
    const storedSettings = (raw as any).settings ?? raw;

    this.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings);

    // Persist normalized settings (without overwriting mapping)
    await this.saveSettings();

    this.addSettingTab(new ConfluenceSettingTab(this.app, this));

    // -----------------------------
    // Mapping stored in plugin data (not vault)
    // -----------------------------
    this.mapping = new MappingService(this);
    try {
      await this.mapping.load();
    } catch (e) {
      console.warn(
        "[Confluence] Mapping load failed on startup (continuing):",
        e,
      );
      new Notice(
        "Confluence Sync: mapping could not be loaded. Exports may recreate pages.",
      );
    }

    // -----------------------------
    // Status bar
    // -----------------------------
    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("Confluence: idle");

    // Init shared services once
    this.rebuildServices();

    // -----------------------------
    // Rename handler: migrate mapping key oldPath -> newPath
    // -----------------------------
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        try {
          const f = file as any;
          if (!f?.path || f?.extension !== "md") return;

          // Ensure mapping is loaded
          try {
            await this.mapping.load();
          } catch (e) {
            console.warn(
              "[Confluence] Mapping load failed during rename (continuing):",
              e,
            );
            return;
          }

          const oldEntry = this.mapping.get(oldPath);
          if (!oldEntry?.pageId) return;

          this.mapping.remove(oldPath);

          this.mapping.set({
            ...oldEntry,
            filePath: f.path,
            title: f.basename ?? oldEntry.title,
            updatedAt: new Date().toISOString(),
          });

          await this.mapping.save();

          console.log(
            `[Confluence] Mapping migrated on rename: ${oldPath} -> ${f.path} (pageId=${oldEntry.pageId})`,
          );
        } catch (e) {
          console.warn("[Confluence] Failed to migrate mapping on rename:", e);
        }
      }),
    );

    // -----------------------------
    // Commands
    // -----------------------------
    this.addCommand({
      id: "confluence-sync-test-connection",
      name: "Confluence Sync: Test connection",
      callback: async () => {
        try {
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
      id: "confluence-sync-write-test",
      name: "Confluence Sync: Write test (create page)",
      callback: async () => {
        try {
          if (!this.settings.spaceKey) {
            new Notice("Set Space Key first.");
            return;
          }

          this.rebuildServices();

          const title = `Obsidian Write Test ${new Date().toISOString()}`;
          const storage = `<p>Write test from Obsidian at ${new Date().toISOString()}</p>`;

          const created = await this.client.createPage(
            this.settings.spaceKey,
            title,
            this.settings.parentPageId || undefined,
            storage,
          );

          new Notice(`Write OK. Created page id=${created.id}`);
          console.log("[Confluence] Write test created:", created);
        } catch (e: any) {
          console.error(e);
          new Notice(`Write test failed: ${e?.message ?? e}`);
        }
      },
    });

    this.addCommand({
      id: "confluence-sync-reset-mapping",
      name: "Confluence Sync: Reset mapping",
      callback: async () => {
        try {
          if (!this.mapping) this.mapping = new MappingService(this);

          await this.mapping.load();
          await this.mapping.reset();

          new Notice(
            "Confluence mapping reset. Next export may recreate pages.",
          );
        } catch (e: any) {
          console.error(e);
          new Notice(`Reset failed: ${e?.message ?? e}`);
        }
      },
    });

    // Review-first export
    this.addCommand({
      id: "confluence-export-review",
      name: "Export to Confluence (Review…)",
      callback: async () => {
        const root = this.app.workspace.getActiveFile() as TFile | null;
        if (!root) {
          new Notice("Open a note to export.");
          return;
        }

        this.rebuildServices();
        await this.mapping.load();

        // 1) collect export set
        const filesToExport = await this.exporter.collectExportSet(root);
        if (filesToExport.length === 0) {
          new Notice("Nothing to export.");
          return;
        }

        const rebuildPlan = async (ctx: {
          spaceKey: string;
          parentPageId?: string;
        }) => {
          await this.mapping.load();

          return await buildExportPlan(
            {
              app: this.app,
              client: this.client,
              mapping: this.mapping,
              settings: {
                updateExisting: this.settings.updateExisting,
              },
            },
            filesToExport,
            {
              spaceKey: ctx.spaceKey,
              parentPageId: ctx.parentPageId,
            },
          );
        };

        // 2) initial plan using current settings.spaceKey as default
        const initialCtx = {
          spaceKey: this.settings.spaceKey,
          parentPageId: undefined,
        };

        const initialPlan = await rebuildPlan(initialCtx);

        // 3) show modal and export selected subset
        new ExportPlanModal(
          this.app,
          initialPlan,
          initialCtx,
          rebuildPlan,
          async (selectedItems, ctx) => {
            const selectedPaths = new Set(selectedItems.map((i) => i.filePath));

            // Temporary override for this run (exporter reads from settings)
            const prevSpace = this.settings.spaceKey;
            const prevParent = this.settings.parentPageId;

            this.settings.spaceKey = ctx.spaceKey;
            this.settings.parentPageId = ctx.parentPageId ?? "";

            try {
              await this.exporter.exportFromRootSelected(root, selectedPaths);
            } finally {
              this.settings.spaceKey = prevSpace;
              this.settings.parentPageId = prevParent;
            }
          },
        ).open();
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
          await this.mapping.load();

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
    this.client = new ConfluenceClient({
      baseUrl: this.settings.baseUrl,
      mode: this.settings.mode,
      authMode: this.settings.authMode,
      username: this.settings.username,
      passwordOrToken: this.settings.passwordOrToken,
      bearerToken: this.settings.bearerToken,
      restApiPathOverride: this.settings.restApiPathOverride,
    });

    // IMPORTANT: keep a single mapping instance (rename handler + exporter share it)
    if (!this.mapping) {
      this.mapping = new MappingService(this);
    }

    this.exporter = new Exporter(
      this.app,
      this.settings,
      this.client,
      this.mapping,
      (text: string) => this.statusEl?.setText(text),
    );
  }

  async saveSettings() {
    const data = (await this.loadData()) ?? {};
    await this.saveData({
      ...data,
      settings: this.settings,
    });

    // Apply changes immediately
    this.rebuildServices();
  }
}
