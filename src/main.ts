import { Plugin, Notice } from "obsidian";
import type { ConfluenceSettings } from "./types";
import { ConfluenceSettingTab, DEFAULT_SETTINGS } from "./settings";
import { ConfluenceClient } from "./confluenceClient";
import { MappingService } from "./mapping";
import { Exporter } from "./exporter";

export default class ConfluenceSyncPlugin extends Plugin {
  settings: ConfluenceSettings = DEFAULT_SETTINGS;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new ConfluenceSettingTab(this.app, this));

    this.addCommand({
      id: "confluence-sync-test-connection",
      name: "Confluence Sync: Test connection",
      callback: async () => {
        try {
          const client = new ConfluenceClient({
            baseUrl: this.settings.baseUrl,
            mode: this.settings.mode,
            authMode: this.settings.authMode,
            username: this.settings.username,
            passwordOrToken: this.settings.passwordOrToken,
            bearerToken: this.settings.bearerToken,
            restApiPathOverride: this.settings.restApiPathOverride,
          });

          const root = await client.ping();
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
          const mapping = new MappingService(
            this.app,
            this.settings.mappingFileName,
          );
          await mapping.load();
          await mapping.reset();
          new Notice(
            "Confluence mapping reset. Next export will recreate pages.",
          );
        } catch (e: any) {
          console.error(e);
          new Notice(`Reset failed: ${e?.message ?? e}`);
        }
      },
    });

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

          const client = new ConfluenceClient({
            baseUrl: this.settings.baseUrl,
            mode: this.settings.mode,
            authMode: this.settings.authMode,
            username: this.settings.username,
            passwordOrToken: this.settings.passwordOrToken,
            bearerToken: this.settings.bearerToken,
            restApiPathOverride: this.settings.restApiPathOverride,
          });

          const mapping = new MappingService(
            this.app,
            this.settings.mappingFileName,
          );
          const exporter = new Exporter(
            this.app,
            this.settings,
            client,
            mapping,
          );

          await exporter.exportFromRoot(file);
        } catch (e: any) {
          console.error(e);
          new Notice(`Export failed: ${e?.message ?? e}`);
        }
      },
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
