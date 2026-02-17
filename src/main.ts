import { Plugin, Notice } from "obsidian";
import type { ConfluenceSettings } from "./types";
import { ConfluenceSettingTab, DEFAULT_SETTINGS } from "./settings";
import { ConfluenceClient } from "./confluenceClient";

export default class ConfluenceSyncPlugin extends Plugin {
  settings: ConfluenceSettings = DEFAULT_SETTINGS;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new ConfluenceSettingTab(this.app, this));

    this.addCommand({
      id: "confluence-sync-export-current",
      name: "Export current note + linked set (stub)",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active note.");
          return;
        }
        new Notice(`Confluence Sync: stub export for "${file.basename}"`);
      }
    });
    
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
  }



  async saveSettings() {
    await this.saveData(this.settings);
  }
}
