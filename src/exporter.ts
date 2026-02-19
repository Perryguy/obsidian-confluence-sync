import { App, TFile, Notice } from "obsidian";
import type { ConfluenceSettings } from "./types";
import type { ConfluenceClient } from "./confluenceClient";
import { ConfluenceStorageConverter } from "./confluenceStorageConverter";
import type { MappingService } from "./mapping";

export type ProgressFn = (text: string) => void;

// Cloud/selfhost safe base for UI URLs.
// If API gives us a relative webui (preferred), we join it to base.
function joinUrl(base: string, relative: string): string {
  const b = base.replace(/\/+$/, "");
  const r = relative.startsWith("/") ? relative : `/${relative}`;
  return `${b}${r}`;
}

export class Exporter {
  private converter = new ConfluenceStorageConverter();

  constructor(
    private app: App,
    private settings: ConfluenceSettings,
    private client: ConfluenceClient,
    private mapping: MappingService,
    private progress: ProgressFn,
  ) {}

  async exportFromRoot(root: TFile): Promise<void> {
    await this.mapping.load();

    const files = await this.buildExportSet(root);
    const ordered = this.orderRootFirst(root, files);

    if (ordered.length === 0) {
      new Notice("Nothing to export.");
      return;
    }

    if (this.settings.dryRun) {
      this.progress(
        `Confluence: DRY RUN — would export ${ordered.length} note(s)`,
      );
      if (this.settings.showProgressNotices)
        new Notice(`Dry run: would export ${ordered.length} note(s)`);
    } else {
      this.progress(`Confluence: exporting ${ordered.length} note(s)…`);
      if (this.settings.showProgressNotices)
        new Notice(`Confluence: exporting ${ordered.length} note(s)…`);
    }

    // Pass 1: ensure root exists first (so we can parent children under it)
    this.progress(`Confluence: Pass 1/2 (root) ${root.basename}`);
    await this.ensurePageForFile(root, undefined);
    await this.mapping.save();

    const rootEntry = this.mapping.get(root.path);
    const rootPageId = rootEntry?.pageId;

    // Parent override for non-root pages if enabled and root exists
    const parentOverride =
      this.settings.childPagesUnderRoot && rootPageId
        ? rootPageId
        : this.settings.parentPageId || undefined;

    // Pass 1: remaining pages
    let idx = 0;
    const totalOthers = Math.max(0, ordered.length - 1);

    for (const f of ordered) {
      if (f.path === root.path) continue;
      idx++;

      this.progress(
        `Confluence: Pass 1/2 (${idx}/${totalOthers}) ${f.basename}`,
      );
      await this.ensurePageForFile(f, parentOverride);

      // Save mapping periodically (safer)
      if (idx % 5 === 0) await this.mapping.save();
    }

    await this.mapping.save();

    // Dry run ends here (don’t attempt link rewrite)
    if (this.settings.dryRun) {
      this.progress(`Confluence: DRY RUN complete (${ordered.length} notes)`);
      if (this.settings.showProgressNotices) new Notice("Dry run complete.");
      return;
    }

    // Pass 2: rewrite links + update content
    let j = 0;
    const total = ordered.length;

    for (const f of ordered) {
      j++;
      this.progress(`Confluence: Pass 2/2 (${j}/${total}) ${f.basename}`);
      await this.updatePageContentWithLinks(f);
    }

    await this.mapping.save();
    this.progress("Confluence: export complete");
    if (this.settings.showProgressNotices)
      new Notice("Confluence export complete.");
  }

  public async collectExportSet(root: TFile): Promise<TFile[]> {
    await this.mapping.load();
    const files = await this.buildExportSet(root);
    return this.orderRootFirst(root, files);
  }

  public async exportFromRootSelected(
    root: TFile,
    selectedPaths: Set<string>,
  ): Promise<void> {
    await this.mapping.load();

    const files = await this.buildExportSet(root);
    const ordered = this.orderRootFirst(root, files).filter((f) =>
      selectedPaths.has(f.path),
    );

    if (ordered.length === 0) {
      new Notice("Nothing selected to export.");
      return;
    }

    // Pass 1 root first (if included)
    const rootIncluded = ordered.some((f) => f.path === root.path);

    if (rootIncluded) {
      this.progress(`Confluence: Pass 1/2 (root) ${root.basename}`);
      await this.ensurePageForFile(root, undefined);
      await this.mapping.save();
    }

    const rootEntry = this.mapping.get(root.path);
    const rootPageId = rootEntry?.pageId;

    const parentOverride =
      this.settings.childPagesUnderRoot && rootPageId
        ? rootPageId
        : this.settings.parentPageId || undefined;

    // Pass 1: remaining selected pages
    let idx = 0;
    const others = ordered.filter((f) => f.path !== root.path);

    for (const f of others) {
      idx++;
      this.progress(
        `Confluence: Pass 1/2 (${idx}/${others.length}) ${f.basename}`,
      );
      await this.ensurePageForFile(f, parentOverride);
      if (idx % 5 === 0) await this.mapping.save();
    }

    await this.mapping.save();

    if (this.settings.dryRun) {
      this.progress(`Confluence: DRY RUN complete (${ordered.length} notes)`);
      if (this.settings.showProgressNotices) new Notice("Dry run complete.");
      return;
    }

    // Pass 2: rewrite links only for selected
    let j = 0;
    for (const f of ordered) {
      j++;
      this.progress(
        `Confluence: Pass 2/2 (${j}/${ordered.length}) ${f.basename}`,
      );
      await this.updatePageContentWithLinks(f);
    }

    await this.mapping.save();
    this.progress("Confluence: export complete");
    if (this.settings.showProgressNotices)
      new Notice("Confluence export complete.");
  }

  // Export set discovery
  private async buildExportSet(root: TFile): Promise<TFile[]> {
    const mode = this.settings.exportMode;

    if (mode === "backlinks")
      return this.unique([root, ...this.getBacklinks(root)]);
    if (mode === "outlinks")
      return this.unique([root, ...this.getOutlinks(root)]);
    return this.unique(this.getGraph(root, this.settings.graphDepth));
  }

  private getBacklinks(root: TFile): TFile[] {
    const resolved = this.app.metadataCache.resolvedLinks;
    const out: TFile[] = [];
    const targetPath = root.path;

    for (const [srcPath, destMap] of Object.entries(resolved)) {
      if (!destMap || typeof destMap !== "object") continue;

      if (Object.prototype.hasOwnProperty.call(destMap, targetPath)) {
        const af = this.app.vault.getAbstractFileByPath(srcPath);
        if (af instanceof TFile && af.extension === "md") out.push(af);
      }
    }

    return out;
  }

  private getOutlinks(root: TFile): TFile[] {
    const cache = this.app.metadataCache.getFileCache(root);
    const links = cache?.links ?? [];
    const out: TFile[] = [];
    for (const l of links) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        l.link,
        root.path,
      );
      if (dest instanceof TFile && dest.extension === "md") out.push(dest);
    }
    return out;
  }

  private getGraph(root: TFile, depth: number): TFile[] {
    const visited = new Set<string>();
    const queue: Array<{ file: TFile; d: number }> = [{ file: root, d: 0 }];
    const out: TFile[] = [];

    while (queue.length) {
      const { file, d } = queue.shift()!;
      if (visited.has(file.path)) continue;
      visited.add(file.path);
      out.push(file);

      if (d >= depth) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const links = cache?.links ?? [];
      for (const l of links) {
        const dest = this.app.metadataCache.getFirstLinkpathDest(
          l.link,
          file.path,
        );
        if (
          dest instanceof TFile &&
          dest.extension === "md" &&
          !visited.has(dest.path)
        ) {
          queue.push({ file: dest, d: d + 1 });
        }
      }
    }

    return out;
  }

  private unique(files: TFile[]): TFile[] {
    const seen = new Set<string>();
    const out: TFile[] = [];
    for (const f of files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
    return out;
  }

  // Pass 1: ensure page exists
  private async ensurePageForFile(
    file: TFile,
    parentIdOverride?: string,
  ): Promise<void> {
    const title = file.basename;
    const md = await this.app.vault.read(file);
    const storage = this.converter.convert(md, this.makeCtx(file));

    const mapped = this.mapping.get(file.path);

    let pageId: string | undefined;
    let webui: string | undefined;

    // 1) Try mapped update
    if (mapped?.pageId && this.settings.updateExisting) {
      try {
        const updated = await this.client.updatePage(
          mapped.pageId,
          title,
          storage,
        );
        pageId = updated.id;
        webui = updated._links?.webui;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes(" 404")) {
          this.mapping.remove(file.path);
        } else {
          throw e;
        }
      }
    }

    // 2) Try title search update
    if (!pageId && this.settings.updateExisting) {
      const found = await this.client.searchPageByTitle(
        this.settings.spaceKey,
        title,
      );
      if (found) {
        const updated = await this.client.updatePage(found.id, title, storage);
        pageId = updated.id;
        webui = updated._links?.webui;
      }
    }

    // 3) Create
    if (!pageId) {
      const parentId =
        parentIdOverride ?? (this.settings.parentPageId || undefined);
      const created = await this.client.createPage(
        this.settings.spaceKey,
        title,
        parentId,
        storage,
      );
      pageId = created.id;
      webui = created._links?.webui;
    }

    // ✅ Guarantee pageId exists from here
    if (!pageId) throw new Error(`Failed to resolve pageId for ${file.path}`);

    // 4) Save mapping
    this.mapping.set({
      filePath: file.path,
      pageId,
      title,
      webui,
      updatedAt: new Date().toISOString(),
    });

    // 4.5) Apply Confluence labels from Obsidian tags
    try {
      const { extractObsidianTags, toConfluenceLabel } = await import("./tags");
      const tags = extractObsidianTags(md)
        .map(toConfluenceLabel)
        .filter(Boolean);
      await this.client.addLabels(pageId, tags);
    } catch (e: any) {
      console.warn("Label sync failed (continuing):", e);
      new Notice(`Label sync failed for "${title}": ${e?.message ?? e}`);
    }

    // 5) Upload embeds ALWAYS
    try {
      await this.uploadEmbedsForPage(file, pageId);
    } catch (e: any) {
      console.error("Attachment upload failed:", e);
      new Notice(`Attachment upload failed for "${title}": ${e?.message ?? e}`);
    }
  }

  private async uploadEmbedsForPage(
    file: TFile,
    pageId: string,
  ): Promise<void> {
    const md = await this.app.vault.read(file);
    const { uploadEmbeddedImages } = await import("./attachments");
    await uploadEmbeddedImages(this.app, this.client, pageId, file, md);
  }

  // Pass 2: rewrite wikilinks using mapping, then update
  private async updatePageContentWithLinks(file: TFile): Promise<void> {
    const entry = this.mapping.get(file.path);
    if (!entry?.pageId) return;

    const title = file.basename;
    const md = await this.app.vault.read(file);
    const storage = this.converter.convert(md, this.makeCtx(file));

    try {
      await this.client.updatePage(entry.pageId, title, storage);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes(" 404")) {
        console.warn(
          `[Confluence] Page missing during pass2 update (skipping): ${entry.pageId} for ${file.path}`,
        );
        this.mapping.remove(file.path);
        return;
      }
      throw e;
    }

    this.mapping.set({
      ...entry,
      title,
      updatedAt: new Date().toISOString(),
    });
  }

  private makeCtx(file: TFile) {
    return {
      spaceKey: this.settings.spaceKey,
      fromPath: file.path,
      resolveWikiLink: (target: string, fromPath: string) => {
        const dest = this.app.metadataCache.getFirstLinkpathDest(
          target,
          fromPath,
        );

        if (dest instanceof TFile) {
          if (dest.extension === "md") {
            const mapped = this.mapping.get(dest.path);
            return { title: mapped?.title ?? dest.basename };
          }

          return { title: dest.name };
        }

        return null;
      },
    };
  }

  private orderRootFirst(root: TFile, files: TFile[]): TFile[] {
    const map = new Map<string, TFile>();
    for (const f of files) map.set(f.path, f);

    const out: TFile[] = [];
    const rootFile = map.get(root.path) ?? root;
    out.push(rootFile);
    map.delete(root.path);

    for (const f of Array.from(map.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      out.push(f);
    }
    return out;
  }
}
