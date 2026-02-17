import { App, TFile, Notice } from "obsidian";
import type { ConfluenceSettings, ExportMode } from "./types";
import type { ConfluenceClient } from "./confluenceClient";
import { SimpleConfluenceConverter } from "./simpleConverter";
import type { MappingService } from "./mapping";

function nowIso(): string {
  return new Date().toISOString();
}

function basenameTitle(file: TFile): string {
  return file.basename;
}

// Cloud/selfhost safe base for UI URLs.
// If API gives us a relative webui (preferred), we join it to base.
function joinUrl(base: string, relative: string): string {
  const b = base.replace(/\/+$/, "");
  const r = relative.startsWith("/") ? relative : `/${relative}`;
  return `${b}${r}`;
}

export class Exporter {
  private converter = new SimpleConfluenceConverter();

  constructor(
    private app: App,
    private settings: ConfluenceSettings,
    private client: ConfluenceClient,
    private mapping: MappingService,
  ) {}

  async exportFromRoot(root: TFile): Promise<void> {
    await this.mapping.load();

    const files = await this.buildExportSet(root);
    if (files.length === 0) {
      new Notice("Nothing to export.");
      return;
    }

    new Notice(`Confluence: exporting ${files.length} note(s)…`);

    // Pass 1: ensure all pages exist + mapping is populated
    for (const f of files) {
      await this.ensurePageForFile(f);
      await this.mapping.save();
    }

    // Pass 2: rewrite internal wikilinks and update content
    for (const f of files) {
      await this.updatePageContentWithLinks(f);
    }

    await this.mapping.save();
    new Notice("Confluence export complete.");
  }

  // -------------------------
  // Export set discovery
  // -------------------------
  private async buildExportSet(root: TFile): Promise<TFile[]> {
    const mode = this.settings.exportMode;

    if (mode === "backlinks")
      return this.unique([root, ...this.getBacklinks(root)]);
    if (mode === "outlinks")
      return this.unique([root, ...this.getOutlinks(root)]);
    return this.unique(this.getGraph(root, this.settings.graphDepth));
  }

  private getBacklinks(root: TFile): TFile[] {
    // resolvedLinks: { [sourcePath: string]: { [destPath: string]: number } }
    const resolved = this.app.metadataCache.resolvedLinks;
    const out: TFile[] = [];

    const targetPath = root.path;

    for (const [srcPath, destMap] of Object.entries(resolved)) {
      if (!destMap || typeof destMap !== "object") continue;

      // If src links to our target
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
  private async ensurePageForFile(file: TFile): Promise<void> {
    const title = basenameTitle(file);
    const md = await this.app.vault.read(file);

    // Minimal body for pass1 (no link rewrite yet)
    const storage = this.converter.convert(md);

    const mapped = this.mapping.get(file.path);

    // Prefer mapping
    if (mapped?.pageId && this.settings.updateExisting) {
      try {
        const updated = await this.client.updatePage(
          mapped.pageId,
          title,
          storage,
        );

        this.mapping.set({
          filePath: file.path,
          pageId: updated.id,
          title,
          webui: updated._links?.webui,
          updatedAt: nowIso(),
        });

        return;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // Page deleted or moved in Confluence → mapping is stale
        if (msg.includes(" 404")) {
          console.warn(
            `[Confluence] Mapped pageId missing (will recreate): ${mapped.pageId} for ${file.path}`,
          );
          this.mapping.remove(file.path); // drop stale mapping and fall through
        } else {
          throw e;
        }
      }
    }

    // Fallback: search by title
    const found = await this.client.searchPageByTitle(
      this.settings.spaceKey,
      title,
    );
    if (found && this.settings.updateExisting) {
      const updated = await this.client.updatePage(found.id, title, storage);
      this.mapping.set({
        filePath: file.path,
        pageId: updated.id,
        title,
        webui: updated._links?.webui,
        updatedAt: nowIso(),
      });
      return;
    }

    // Create new
    const created = await this.client.createPage(
      this.settings.spaceKey,
      title,
      this.settings.parentPageId || undefined,
      storage,
    );

    this.mapping.set({
      filePath: file.path,
      pageId: created.id,
      title,
      webui: created._links?.webui,
      updatedAt: nowIso(),
    });
  }

  // Pass 2: rewrite wikilinks using mapping, then update
  private async updatePageContentWithLinks(file: TFile): Promise<void> {
    const entry = this.mapping.get(file.path);
    if (!entry?.pageId) return;

    const title = basenameTitle(file);
    const md = await this.app.vault.read(file);

    const rewritten = this.rewriteWikilinksToMarkdownLinks(md, file);
    const storage = this.converter.convert(rewritten);

    try {
      await this.client.updatePage(entry.pageId, title, storage);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes(" 404")) {
        console.warn(
          `[Confluence] Page missing during pass2 update (skipping): ${entry.pageId} for ${file.path}`,
        );
        this.mapping.remove(file.path);
        return; // next export will recreate
      }
      throw e;
    }

    this.mapping.set({
      ...entry,
      title,
      updatedAt: nowIso(),
    });
  }

  private rewriteWikilinksToMarkdownLinks(
    markdown: string,
    fromFile: TFile,
  ): string {
    // Supports: [[Note]] and [[Note|Alias]] and [[Note#Heading]] (heading ignored)
    // Converts to standard markdown link: [Alias](<absolute_confluence_url>)
    // Uses mapping webui if available; else falls back to plain text.

    const base = this.settings.baseUrl.replace(/\/+$/, ""); // for Cloud this likely includes /wiki
    return markdown.replace(
      /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
      (_m, rawTarget, rawAlias) => {
        const target = String(rawTarget).trim();
        const alias = rawAlias ? String(rawAlias).trim() : target;

        // Resolve Obsidian link to a file, then look up mapping by file path
        const dest = this.app.metadataCache.getFirstLinkpathDest(
          target,
          fromFile.path,
        );
        if (dest instanceof TFile) {
          const mapped = this.mapping.get(dest.path);
          if (mapped?.webui) {
            const url = joinUrl(base, mapped.webui);
            return `[${alias}](${url})`;
          }
        }

        // If we can't resolve/match, keep readable text
        return alias;
      },
    );
  }
}
