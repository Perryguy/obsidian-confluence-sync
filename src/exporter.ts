// src/exporter.ts
import { App, TFile, Notice } from "obsidian";
import type {
  ConfluenceSettings,
  HierarchyMode,
  ManyToManyPolicy,
} from "./types";
import type { ConfluenceClient } from "./confluenceClient";
import { ConfluenceStorageConverter } from "./confluenceStorageConverter";
import type { MappingService } from "./mapping";
import { SnapshotService } from "./snapshots";
import { normaliseStorage } from "./storageNormalise";
import { buildHierarchy } from "./hierarchy";
import type { ExportPlanItem } from "./exportPlan";

export type ProgressFn = (text: string) => void;

export type HierarchyRunOptions = {
  hierarchyMode?: HierarchyMode;
  hierarchyManyToManyPolicy?: ManyToManyPolicy;
};

export class Exporter {
  private converter = new ConfluenceStorageConverter();
  private snapshots: SnapshotService;

  // Path -> whether we should apply label changes for this file during this export
  private applyLabelsByPath: Map<string, boolean> | null = null;

  constructor(
    private app: App,
    private settings: ConfluenceSettings,
    private client: ConfluenceClient,
    private mapping: MappingService,
    private progress: ProgressFn,
  ) {
    this.snapshots = new SnapshotService(app);
  }

  // -----------------------------------------
  // Publish markdown pipeline
  // -----------------------------------------
  private toPublishMarkdown(markdown: string): string {
    if (!markdown) return "";

    // 1) Remove frontmatter
    let s = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");

    // 2) Protect fenced code blocks + inline code
    const holes: string[] = [];
    s = s.replace(/```[\s\S]*?```/g, (m) => {
      holes.push(m);
      return `@@HOLE_${holes.length - 1}@@`;
    });
    s = s.replace(/~~~[\s\S]*?~~~/g, (m) => {
      holes.push(m);
      return `@@HOLE_${holes.length - 1}@@`;
    });
    s = s.replace(/`[^`]*`/g, (m) => {
      holes.push(m);
      return `@@HOLE_${holes.length - 1}@@`;
    });

    // 3) Strip inline tags
    s = s.replace(/(^|[\s(])#([A-Za-z0-9/_-]+)\b/gm, "$1");

    // 4) Restore holes
    s = s.replace(/@@HOLE_(\d+)@@/g, (_m, idx) => {
      const i = Number(idx);
      return Number.isFinite(i) ? (holes[i] ?? "") : "";
    });

    // 5) Normalise
    s = s
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/g, ""))
      .join("\n")
      .trim();

    return s;
  }

  // -----------------------------------------
  // Public API
  // -----------------------------------------
  async exportFromRoot(root: TFile): Promise<void> {
    return this.exportInternal(root, undefined, undefined, null);
  }

  public async collectExportSet(
    root: TFile,
    opts?: HierarchyRunOptions,
  ): Promise<TFile[]> {
    await this.mapping.load();
    const files = await this.buildExportSet(root);

    const { ordered } = this.computeHierarchyAndOrder(root, files, opts);
    return ordered;
  }

  /**
   * Backwards-compatible:
   * - pass Set<string> like before
   * - OR pass ExportPlanItem[] (so we can read per-item applyLabelChanges)
   */
  public async exportFromRootSelected(
    root: TFile,
    selected: Set<string> | ExportPlanItem[],
    opts?: HierarchyRunOptions,
  ): Promise<void> {
    if (Array.isArray(selected)) {
      const selectedPaths = new Set(selected.map((i) => i.filePath));
      const applyLabelsByPath = new Map<string, boolean>();
      for (const i of selected) {
        applyLabelsByPath.set(i.filePath, i.applyLabelChanges !== false);
      }
      return this.exportInternal(root, selectedPaths, opts, applyLabelsByPath);
    }

    // old usage: just a Set of paths
    return this.exportInternal(root, selected, opts, null);
  }

  // -----------------------------------------
  // Core export routine (shared)
  // -----------------------------------------
  private async exportInternal(
    root: TFile,
    selectedPaths?: Set<string>,
    opts?: HierarchyRunOptions,
    applyLabelsByPath?: Map<string, boolean> | null,
  ): Promise<void> {
    await this.mapping.load();

    // make available to syncLabelsForPage / ensurePageForFile / pass2
    this.applyLabelsByPath = applyLabelsByPath ?? null;

    const files = await this.buildExportSet(root);
    const filtered = selectedPaths
      ? files.filter((f) => selectedPaths.has(f.path))
      : files;

    const inSet = this.ensureRootPresent(root, filtered);

    const { ordered, parentByPath } = this.computeHierarchyAndOrder(
      root,
      inSet,
      opts,
    );

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

    const rootParent = this.settings.parentPageId || undefined;

    // -----------------------------
    // Pass 1: ensure pages exist
    // -----------------------------
    let idx = 0;
    for (const f of ordered) {
      idx++;
      this.progress(
        `Confluence: Pass 1/2 (${idx}/${ordered.length}) ${f.basename}`,
      );

      const isRoot = f.path === root.path;
      let parentIdOverride: string | undefined;

      if (isRoot) {
        parentIdOverride = rootParent;
      } else {
        const parentPath = parentByPath.get(f.path) ?? root.path;

        if (this.getHierarchyMode(opts) === "flat") {
          const rootEntry = this.mapping.get(root.path);
          const rootPageId = rootEntry?.pageId;

          parentIdOverride =
            this.settings.childPagesUnderRoot && rootPageId
              ? rootPageId
              : rootParent;
        } else {
          const parentEntry = this.mapping.get(parentPath);
          const parentPageId = parentEntry?.pageId;
          parentIdOverride = parentPageId ?? rootParent;
        }
      }

      await this.ensurePageForFile(f, parentIdOverride);

      if (idx % 5 === 0) await this.mapping.save();
    }

    await this.mapping.save();

    if (this.settings.dryRun) {
      this.progress(`Confluence: DRY RUN complete (${ordered.length} notes)`);
      if (this.settings.showProgressNotices) new Notice("Dry run complete.");
      return;
    }

    // -----------------------------
    // Pass 2: update storage content now that mappings exist
    // -----------------------------
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

  private shouldApplyLabels(filePath: string): boolean {
    if (!this.applyLabelsByPath) return true; // default: apply labels
    const v = this.applyLabelsByPath.get(filePath);
    return v !== false;
  }

  // -----------------------------------------
  // Export set discovery
  // -----------------------------------------
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

  // -----------------------------------------
  // Pass 1: ensure page exists
  // -----------------------------------------
  private async ensurePageForFile(
    file: TFile,
    parentIdOverride?: string,
  ): Promise<void> {
    const title = file.basename;

    const mdOriginal = await this.app.vault.read(file);
    const mdPublish = this.toPublishMarkdown(mdOriginal);

    const storageRaw = this.converter.convert(mdPublish, this.makeCtx(file));
    const storageNorm = normaliseStorage(storageRaw);

    const mapped = this.mapping.get(file.path);

    let pageId: string | undefined;
    let webui: string | undefined;

    if (mapped?.pageId && this.settings.updateExisting) {
      try {
        const updated = await this.client.updatePage(
          mapped.pageId,
          title,
          storageRaw,
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

    if (!pageId && this.settings.updateExisting) {
      const found = await this.client.searchPageByTitle(
        this.settings.spaceKey,
        title,
      );
      if (found) {
        const updated = await this.client.updatePage(
          found.id,
          title,
          storageRaw,
        );
        pageId = updated.id;
        webui = updated._links?.webui;
      }
    }

    if (!pageId) {
      const parentId =
        parentIdOverride ?? (this.settings.parentPageId || undefined);
      const created = await this.client.createPage(
        this.settings.spaceKey,
        title,
        parentId,
        storageRaw,
      );
      pageId = created.id;
      webui = created._links?.webui;
    }

    if (!pageId) throw new Error(`Failed to resolve pageId for ${file.path}`);

    this.mapping.set({
      filePath: file.path,
      pageId,
      title,
      webui,
      updatedAt: new Date().toISOString(),
    });

    // Snapshots
    if (!this.settings.dryRun) {
      try {
        await this.snapshots.writeSnapshot(file.path, mdPublish);
      } catch {}
      try {
        await this.snapshots.writeStorageSnapshot(file.path, storageNorm);
      } catch {}
    }

    // Labels (respect per-item toggle)
    if (this.shouldApplyLabels(file.path)) {
      try {
        await this.syncLabelsForPage(pageId, mdOriginal);
      } catch (e: any) {
        console.warn("Label sync failed (continuing):", e);
        new Notice(`Label sync failed for "${title}": ${e?.message ?? e}`);
      }
    }

    // Upload embeds
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

  // -----------------------------------------
  // Pass 2: update content + title
  // -----------------------------------------
  private async updatePageContentWithLinks(file: TFile): Promise<void> {
    const entry = this.mapping.get(file.path);
    if (!entry?.pageId) return;

    const desiredTitle = file.basename;

    const mdOriginal = await this.app.vault.read(file);
    const mdPublish = this.toPublishMarkdown(mdOriginal);

    const newStorageRaw = this.converter.convert(mdPublish, this.makeCtx(file));
    const newStorageNorm = normaliseStorage(newStorageRaw);

    // Fetch current Confluence page
    let existingTitle = "";
    let existingStorageRaw = "";
    try {
      const existing = await this.client.getPageWithStorage(entry.pageId);
      existingTitle = String(existing?.title ?? "");
      existingStorageRaw = existing?.body?.storage?.value ?? "";
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes(" 404")) {
        this.mapping.remove(file.path);
        return;
      }
      throw e;
    }

    const existingStorageNorm = normaliseStorage(existingStorageRaw);

    // Prefer last-exported storage snapshot as baseline
    let baselineStorageNorm: string | null = null;
    try {
      baselineStorageNorm = await this.snapshots.readStorageSnapshot(file.path);
    } catch {
      baselineStorageNorm = null;
    }

    const bodyUnchanged =
      (baselineStorageNorm ?? existingStorageNorm) === newStorageNorm;
    const titleUnchanged = (existingTitle || "").trim() === desiredTitle.trim();

    if (bodyUnchanged && titleUnchanged) {
      // Still sync labels so tag-only changes apply (respect per-item toggle)
      if (this.shouldApplyLabels(file.path)) {
        try {
          await this.syncLabelsForPage(entry.pageId, mdOriginal);
        } catch (e: any) {
          console.warn("Label sync failed (continuing):", e);
          new Notice(
            `Label sync failed for "${desiredTitle}": ${e?.message ?? e}`,
          );
        }
      }

      // refresh snapshots so plan stays stable
      try {
        await this.snapshots.writeSnapshot(file.path, mdPublish);
      } catch {}
      try {
        await this.snapshots.writeStorageSnapshot(file.path, newStorageNorm);
      } catch {}

      return;
    }

    try {
      await this.client.updatePage(entry.pageId, desiredTitle, newStorageRaw);

      // After update, sync labels if enabled for this item
      if (this.shouldApplyLabels(file.path)) {
        try {
          await this.syncLabelsForPage(entry.pageId, mdOriginal);
        } catch (e: any) {
          console.warn("Label sync failed (continuing):", e);
          new Notice(
            `Label sync failed for "${desiredTitle}": ${e?.message ?? e}`,
          );
        }
      }

      try {
        await this.snapshots.writeSnapshot(file.path, mdPublish);
      } catch {}
      try {
        await this.snapshots.writeStorageSnapshot(file.path, newStorageNorm);
      } catch {}
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes(" 404")) {
        this.mapping.remove(file.path);
        return;
      }
      throw e;
    }

    this.mapping.set({
      ...entry,
      title: desiredTitle,
      updatedAt: new Date().toISOString(),
    });
  }

  // -----------------------------------------
  // Link resolution context for converter
  // -----------------------------------------
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

  // -----------------------------------------
  // Hierarchy helpers (ordering + opts)
  // -----------------------------------------
  private getHierarchyMode(opts?: HierarchyRunOptions): HierarchyMode {
    return (
      opts?.hierarchyMode ?? (this.settings as any).hierarchyMode ?? "flat"
    );
  }

  private getManyToManyPolicy(opts?: HierarchyRunOptions): ManyToManyPolicy {
    return (
      opts?.hierarchyManyToManyPolicy ??
      (this.settings as any).hierarchyManyToManyPolicy ??
      "firstSeen"
    );
  }

  private computeHierarchyAndOrder(
    root: TFile,
    files: TFile[],
    opts?: HierarchyRunOptions,
  ): { ordered: TFile[]; parentByPath: Map<string, string | null> } {
    const mode = this.getHierarchyMode(opts);
    const policy = this.getManyToManyPolicy(opts);

    const hier = buildHierarchy(this.app, root, files, mode, policy);
    const parentByPath = hier.parentPathByPath;

    const ordered = this.orderByParentMap(root, files, parentByPath);

    return { ordered, parentByPath };
  }

  private orderByParentMap(
    root: TFile,
    files: TFile[],
    parentByPath: Map<string, string | null>,
  ): TFile[] {
    const fileByPath = new Map<string, TFile>();
    for (const f of files) fileByPath.set(f.path, f);

    const children = new Map<string, string[]>();
    for (const f of files) {
      const child = f.path;
      const parent = parentByPath.get(child);

      if (parent == null) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(child);
    }

    for (const arr of children.values()) arr.sort((a, b) => a.localeCompare(b));

    const out: TFile[] = [];
    const visited = new Set<string>();

    const walk = (path: string) => {
      if (visited.has(path)) return;
      visited.add(path);

      const f = fileByPath.get(path);
      if (f) out.push(f);

      const kids = children.get(path) ?? [];
      for (const k of kids) walk(k);
    };

    if (fileByPath.has(root.path)) walk(root.path);

    const remaining = Array.from(fileByPath.keys()).filter(
      (p) => !visited.has(p),
    );
    remaining.sort((a, b) => a.localeCompare(b));
    for (const p of remaining) walk(p);

    return out;
  }

  private async syncLabelsForPage(
    pageId: string,
    mdOriginal: string,
  ): Promise<void> {
    const { extractObsidianTags, toConfluenceLabel } = await import("./tags");

    let desired = extractObsidianTags(mdOriginal)
      .map(toConfluenceLabel)
      .filter(Boolean);

    if (!this.settings.includeInlineTagsForLabels) {
      const mdNoInline = mdOriginal.replace(
        /(^|[\s(])#([A-Za-z0-9/_-]+)\b/gm,
        "$1",
      );
      desired = extractObsidianTags(mdNoInline)
        .map(toConfluenceLabel)
        .filter(Boolean);
    }

    desired = Array.from(new Set(desired));

    const existing = Array.from(new Set(await this.client.getLabels(pageId)));

    const existingSet = new Set(existing);
    const desiredSet = new Set(desired);

    const toAdd = desired.filter((x) => !existingSet.has(x));
    const toRemove = existing.filter((x) => !desiredSet.has(x));

    if (toAdd.length > 0) await this.client.addLabels(pageId, toAdd);

    if (this.settings.labelSyncMode === "strict" && toRemove.length > 0) {
      await this.client.removeLabels(pageId, toRemove);
    }
  }

  private ensureRootPresent(root: TFile, files: TFile[]): TFile[] {
    const hasRoot = files.some((f) => f.path === root.path);
    return hasRoot ? files : [root, ...files];
  }
}
