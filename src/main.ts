import { Plugin, Notice } from "obsidian";
import type { ConfluenceSettings } from "./types";
import { ConfluenceSettingTab, DEFAULT_SETTINGS } from "./settings";
import { ConfluenceClient } from "./confluenceClient";
import { SimpleConfluenceConverter } from "./simpleConverter";

export default class ConfluenceSyncPlugin extends Plugin {
  settings: ConfluenceSettings = DEFAULT_SETTINGS;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new ConfluenceSettingTab(this.app, this));

    // 1) Test connection
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
            restApiPathOverride: this.settings.restApiPathOverride
          });

          const root = await client.ping();
          new Notice(`Confluence OK. REST root: ${root}`);
        } catch (e: any) {
          console.error(e);
          new Notice(`Confluence failed: ${e?.message ?? e}`);
        }
      }
    });

    // 2) Export current note (create or update)
    this.addCommand({
      id: "confluence-sync-export-current",
      name: "Confluence Sync: Export current note",
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
            restApiPathOverride: this.settings.restApiPathOverride
          });

          const md = await this.app.vault.read(file);
          const converter = new SimpleConfluenceConverter();
          const storage = converter.convert(md);

          const title = file.basename;

          // Create or update (title-based for milestone 2)
          const existing = await client.searchPageByTitle(this.settings.spaceKey, title);

          if (existing && this.settings.updateExisting) {
            await client.updatePage(existing.id, title, storage);
            new Notice(`Updated Confluence page: ${title}`);
          } else {
            const created = await client.createPage(
              this.settings.spaceKey,
              title,
              this.settings.parentPageId || undefined,
              storage
            );
            new Notice(`Created Confluence page: ${title} (id ${created.id})`);
          }
        } catch (e: any) {
          console.error(e);
          new Notice(`Export failed: ${e?.message ?? e}`);
        }
      }
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}