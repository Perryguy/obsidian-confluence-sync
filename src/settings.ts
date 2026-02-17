import { App, PluginSettingTab, Setting } from "obsidian";
import type { ConfluenceSettings, ExportMode } from "./types";

// Avoid importing from ./main (prevents circular deps & “no default export” weirdness)
type PluginLike = {
  settings: ConfluenceSettings;
  saveSettings: () => Promise<void>;
};

export const DEFAULT_SETTINGS: ConfluenceSettings = {
  baseUrl: "https://your-site.atlassian.net/wiki",
  mode: "auto",

  authMode: "basic",
  username: "",
  passwordOrToken: "",
  bearerToken: "",

  restApiPathOverride: "",

  spaceKey: "",
  parentPageId: "",

  exportMode: "backlinks",
  graphDepth: 1,

  updateExisting: true,
  storeContentProperties: true,

  mappingFileName: "confluence-mapping.json"
};

export class ConfluenceSettingTab extends PluginSettingTab {
  plugin: PluginLike;

  constructor(app: App, plugin: PluginLike) {
    super(app, plugin as any);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Confluence Sync" });

    new Setting(containerEl)
      .setName("Mode")
      .setDesc("Auto will try cloud/self-hosted REST paths and pick the first that works.")
      .addDropdown((d: any) =>
        d
          .addOption("auto", "Auto")
          .addOption("cloud", "Cloud")
          .addOption("selfHosted", "Self-hosted (Server/DC)")
          .setValue(this.plugin.settings.mode)
          .onChange(async (v: string) => {
            this.plugin.settings.mode = v as any;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
  .setName("Base URL")
  .setDesc(
    this.plugin.settings.mode === "selfHosted"
      ? "Self-hosted example: https://confluence.company.com"
      : "Cloud example: https://your-site.atlassian.net"
  )
  .addText((t: any) =>
    t.setValue(this.plugin.settings.baseUrl).onChange(async (v: string) => {
      this.plugin.settings.baseUrl = v.trim();
      await this.plugin.saveSettings();
    })
  );

    new Setting(containerEl)
      .setName("Auth mode")
      .addDropdown((d: any) =>
        d
          .addOption("bearer", "Bearer (PAT)")
          .addOption("basic", "Basic (username/email + password/token)")
          .setValue(this.plugin.settings.authMode)
          .onChange(async (v: string) => {
            this.plugin.settings.authMode = v as any;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.authMode === "basic") {
      new Setting(containerEl)
        .setName("Username / Email")
        .setDesc("Cloud: email. Self-hosted: username.")
        .addText((t: any) =>
          t.setValue(this.plugin.settings.username).onChange(async (v: string) => {
            this.plugin.settings.username = v.trim();
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName("Password / Token")
        .setDesc("Cloud: API token. Self-hosted: password or token (depends on config).")
        .addText((t: any) =>
          t.setValue(this.plugin.settings.passwordOrToken).onChange(async (v: string) => {
            this.plugin.settings.passwordOrToken = v;
            await this.plugin.saveSettings();
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Bearer token (PAT)")
        .addText((t: any) =>
          t.setValue(this.plugin.settings.bearerToken).onChange(async (v: string) => {
            this.plugin.settings.bearerToken = v.trim();
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl)
      .setName("REST API path override (optional)")
      .setDesc("Leave empty to auto-detect. Examples: /rest/api, /wiki/rest/api, /confluence/rest/api")
      .addText((t: any) =>
        t.setValue(this.plugin.settings.restApiPathOverride ?? "").onChange(async (v: string) => {
          this.plugin.settings.restApiPathOverride = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Space Key")
      .setDesc("Space Key (not the space name). Example: ENG.\n" +
  "Cloud URL: https://site.atlassian.net/wiki/spaces/ENG/pages/...\n" +
  "Self-hosted URL: https://confluence.company.com/spaces/ENG/...")
      .addText((t: any) =>
        t.setValue(this.plugin.settings.spaceKey).onChange(async (v: string) => {
          this.plugin.settings.spaceKey = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Parent Page ID (optional)")
      .setDesc("If set, exported pages are created beneath this page.")
      .addText((t: any) =>
        t.setValue(this.plugin.settings.parentPageId ?? "").onChange(async (v: string) => {
          this.plugin.settings.parentPageId = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Export Mode")
      .addDropdown((d: any) =>
        d
          .addOption("backlinks", "Backlinks (notes linking to current)")
          .addOption("outlinks", "Outlinks (notes current links to)")
          .addOption("graph", "Graph crawl (BFS)")
          .setValue(this.plugin.settings.exportMode)
          .onChange(async (v: string) => {
            this.plugin.settings.exportMode = v as ExportMode;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.exportMode === "graph") {
      new Setting(containerEl)
        .setName("Graph Depth")
        .setDesc("How many link-hops to crawl from the current note.")
        .addSlider((s: any) =>
          s
            .setLimits(1, 5, 1)
            .setValue(this.plugin.settings.graphDepth)
            .setDynamicTooltip()
            .onChange(async (v: number) => {
              this.plugin.settings.graphDepth = v;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Update existing pages")
      .setDesc("If enabled, updates pages if found (mapping or title search).")
      .addToggle((t: any) =>
        t.setValue(this.plugin.settings.updateExisting).onChange(async (v: boolean) => {
          this.plugin.settings.updateExisting = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
