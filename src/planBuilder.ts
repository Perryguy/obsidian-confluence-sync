// src/planBuilder.ts
import { App, TFile } from "obsidian";
import type { ConfluenceClient } from "./confluenceClient";
import type { ExportPlanItem } from "./exportPlan";
import { ConfluenceStorageConverter } from "./confluenceStorageConverter";
import { normaliseStorage } from "./storageNormalise";
import { SnapshotService } from "./snapshots";
import { buildHierarchy } from "./hierarchy";
import type { HierarchyMode, ManyToManyPolicy } from "./types";
import { stripInlineTagsFromMarkdown } from "./stripTags";
import { extractObsidianTags, toConfluenceLabel } from "./tags";

export interface PlanBuilderDeps {
  app: App;
  client: ConfluenceClient;
  mapping: {
    get: (
      path: string,
    ) => { pageId?: string; title?: string; webui?: string } | undefined;
  };
  settings: {
    updateExisting: boolean;
    includeInlineTagsForLabels: boolean;
  };
}

export interface ExportReviewContext {
  spaceKey: string;
  parentPageId?: string;

  hierarchyMode: HierarchyMode;
  hierarchyManyToManyPolicy: ManyToManyPolicy;
}

function normaliseTextForDiff(t: string): string {
  const s = (t ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n");

  return s.replace(/\n+$/g, "");
}

function uniqSorted(xs: string[]): string[] {
  const out = Array.from(
    new Set((xs ?? []).map((x) => (x ?? "").trim()).filter(Boolean)),
  );
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function setDiff(existing: string[], desired: string[]) {
  const a = uniqSorted(existing);
  const b = uniqSorted(desired);

  const A = new Set(a);
  const B = new Set(b);

  const toAdd = b.filter((x) => !A.has(x));
  const toRemove = a.filter((x) => !B.has(x));

  return {
    toAdd,
    toRemove,
    changed: toAdd.length > 0 || toRemove.length > 0,
  };
}

function splitFrontmatter(markdown: string): {
  frontmatter: string | null;
  body: string;
} {
  const md = markdown ?? "";
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { frontmatter: null, body: md };
  const fm = m[1] ?? "";
  const body = md.slice(m[0].length);
  return { frontmatter: fm, body };
}

function stripInlineTagsBodyOnly(body: string): string {
  // Same intent as stripTags.ts: remove inline tags while avoiding code blocks/spans.
  // Here we only need “good enough” for label extraction when inline tags are disabled.
  let s = body ?? "";

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

  // Remove inline tags (keep separator)
  s = s.replace(/(^|[\s(])#([A-Za-z0-9/_-]+)\b/gm, "$1");

  // Restore holes
  s = s.replace(/@@HOLE_(\d+)@@/g, (_m, idx) => {
    const i = Number(idx);
    return Number.isFinite(i) ? (holes[i] ?? "") : "";
  });

  return s;
}

function computeDesiredLabels(mdRaw: string, includeInline: boolean): string[] {
  // Always labelise -> normalised
  if (includeInline) {
    return uniqSorted(
      extractObsidianTags(mdRaw).map(toConfluenceLabel).filter(Boolean),
    );
  }

  // ✅ Properly exclude inline tags:
  // - keep frontmatter as-is
  // - strip inline tags only from body
  const { frontmatter, body } = splitFrontmatter(mdRaw);
  const bodyNoInline = stripInlineTagsBodyOnly(body);
  const recombined =
    frontmatter != null
      ? `---\n${frontmatter}\n---\n${bodyNoInline}`
      : bodyNoInline;

  return uniqSorted(
    extractObsidianTags(recombined).map(toConfluenceLabel).filter(Boolean),
  );
}

export async function buildExportPlan(
  deps: PlanBuilderDeps,
  files: TFile[],
  ctx: ExportReviewContext,
  root: TFile,
): Promise<ExportPlanItem[]> {
  const items: ExportPlanItem[] = [];
  const converter = new ConfluenceStorageConverter();
  const snapshots = new SnapshotService(deps.app);

  const hierarchy = buildHierarchy(
    deps.app,
    root,
    files,
    ctx.hierarchyMode,
    ctx.hierarchyManyToManyPolicy,
  );

  const resolveWikiLink = (target: string, fromPath: string) => {
    const dest = deps.app.metadataCache.getFirstLinkpathDest(target, fromPath);
    if (dest && typeof dest === "object" && "extension" in (dest as any)) {
      const d = dest as any;
      if (d.extension === "md") {
        const mapped2 = deps.mapping.get(d.path);
        return { title: mapped2?.title ?? d.basename };
      }
      return { title: d.name };
    }
    return null;
  };

  for (const file of files) {
    const title = file.basename;
    const mapped = deps.mapping.get(file.path);

    const item: ExportPlanItem = {
      filePath: file.path,
      title,
      selected: true,
      action: "create",
      reason: "No mapping found.",
      hasSnapshot: false,
      hasDiff: false,

      intendedParentFilePath: hierarchy.parentPathByPath.get(file.path) ?? null,
      depth: hierarchy.depthByPath.get(file.path) ?? 0,

      applyLabelChanges: true,
    };

    const mdRaw = await deps.app.vault.read(file);

    // Desired labels from RAW markdown (frontmatter + optional inline)
    item.labelsDesired = computeDesiredLabels(
      mdRaw,
      deps.settings.includeInlineTagsForLabels ?? true,
    );

    // Publish-clean markdown for storage + diff
    const mdPublish = stripInlineTagsFromMarkdown(mdRaw);

    // ---------- CASE 1: Mapping exists ----------
    if (mapped?.pageId) {
      try {
        const page = await deps.client.getPageWithStorage(mapped.pageId);
        const existingStorage = page?.body?.storage?.value ?? "";

        const newStorage = converter.convert(mdPublish, {
          spaceKey: ctx.spaceKey,
          fromPath: file.path,
          resolveWikiLink,
        });

        const b = normaliseStorage(newStorage);

        const oldStorageSnap = await snapshots.readStorageSnapshot?.(file.path);
        const a = oldStorageSnap ?? normaliseStorage(existingStorage);

        item.pageId = String(page.id);
        item.webui = page._links?.webui
          ? deps.client.toWebUrl(page._links.webui)
          : mapped.webui;

        const existingTitle = String(page?.title ?? mapped.title ?? title);
        item.existingTitle = existingTitle;
        item.titleChanged = existingTitle !== title;

        const contentDiffers = a !== b;

        // Labels diff (existing vs desired)
        try {
          const existingLabelsRaw = await deps.client.getLabels(item.pageId);
          const existingLabels = uniqSorted(existingLabelsRaw);
          item.labelsExisting = existingLabels;

          const d = setDiff(existingLabels, item.labelsDesired ?? []);
          item.labelsToAdd = d.toAdd;
          item.labelsToRemove = d.toRemove;
          item.labelsChanged = d.changed;
        } catch (e: any) {
          item.labelsExisting = [];
          item.labelsToAdd = item.labelsDesired ?? [];
          item.labelsToRemove = [];
          item.labelsChanged = (item.labelsToAdd?.length ?? 0) > 0;
          item.reason += " (Could not read existing labels; will attempt add.)";
        }

        // Snapshot awareness for diff UI
        const snapMdExists = await snapshots.hasSnapshot(file.path);
        item.hasSnapshot = snapMdExists;

        if (snapMdExists) {
          const oldMdRaw = (await snapshots.readSnapshot(file.path)) ?? "";
          const oldMdPublish = stripInlineTagsFromMarkdown(oldMdRaw);
          item.diffOld = normaliseTextForDiff(oldMdPublish);
          item.diffNew = normaliseTextForDiff(mdPublish);
          item.hasDiff = true;
        } else {
          item.diffOld = "";
          item.diffNew = normaliseTextForDiff(mdPublish);
          item.hasDiff = true;
          item.reason +=
            " (No markdown snapshot yet — showing cleaned note only.)";
        }

        const needsUpdate =
          contentDiffers || item.titleChanged || !!item.labelsChanged;

        if (!needsUpdate) {
          item.action = "skip";
          item.selected = false;
          item.hasDiff = false;
          item.reason = oldStorageSnap
            ? "No content/label changes detected (storage snapshot baseline)."
            : "No content/label changes detected (normalized).";
        } else {
          item.action = "update";
          item.selected = true;
          item.hasDiff = true;

          if (item.titleChanged) {
            item.reason = "Title changed (will update page title).";
          } else if (contentDiffers) {
            item.reason = oldStorageSnap
              ? "Content differs from last export (storage snapshot baseline)."
              : "Content differs from Confluence (normalized).";
          } else {
            item.reason = "Labels changed (tag-only change).";
          }
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);

        if (msg.includes(" 404")) {
          item.action = "recreate";
          item.selected = true;
          item.pageId = mapped.pageId;
          item.hasDiff = true;

          const snapMdExists = await snapshots.hasSnapshot(file.path);
          item.hasSnapshot = snapMdExists;

          item.diffOld = normaliseTextForDiff(
            snapMdExists
              ? stripInlineTagsFromMarkdown(
                  (await snapshots.readSnapshot(file.path)) ?? "",
                )
              : "",
          );
          item.diffNew = normaliseTextForDiff(mdPublish);

          item.reason =
            "Mapping exists but page was deleted (404). Will recreate.";
        } else {
          item.action = "skip";
          item.selected = false;
          item.hasDiff = false;
          item.reason = `Could not verify mapped page: ${msg}`;
        }
      }
    }

    // ---------- CASE 2: No mapping, but updateExisting enabled ----------
    else if (deps.settings.updateExisting) {
      try {
        const found = await deps.client.searchPageByTitle(ctx.spaceKey, title);

        if (found?.id) {
          const page = await deps.client.getPageWithStorage(found.id);
          const existingStorage = page?.body?.storage?.value ?? "";

          const newStorage = converter.convert(mdPublish, {
            spaceKey: ctx.spaceKey,
            fromPath: file.path,
            resolveWikiLink,
          });

          const b = normaliseStorage(newStorage);

          const oldStorageSnap = await snapshots.readStorageSnapshot?.(
            file.path,
          );
          const a = oldStorageSnap ?? normaliseStorage(existingStorage);

          const contentDiffers = a !== b;

          item.pageId = String(page?.id ?? found.id);
          item.webui = page?._links?.webui
            ? deps.client.toWebUrl(page._links.webui)
            : found._links?.webui
              ? deps.client.toWebUrl(found._links.webui)
              : undefined;

          // Labels diff
          try {
            const existingLabelsRaw = await deps.client.getLabels(item.pageId);
            const existingLabels = uniqSorted(existingLabelsRaw);
            item.labelsExisting = existingLabels;

            const d = setDiff(existingLabels, item.labelsDesired ?? []);
            item.labelsToAdd = d.toAdd;
            item.labelsToRemove = d.toRemove;
            item.labelsChanged = d.changed;
          } catch {
            item.labelsExisting = [];
            item.labelsToAdd = item.labelsDesired ?? [];
            item.labelsToRemove = [];
            item.labelsChanged = (item.labelsToAdd?.length ?? 0) > 0;
          }

          const needsUpdate = contentDiffers || !!item.labelsChanged;

          const snapMdExists = await snapshots.hasSnapshot(file.path);
          item.hasSnapshot = snapMdExists;
          item.hasDiff = true;

          if (snapMdExists) {
            const oldMdRaw = (await snapshots.readSnapshot(file.path)) ?? "";
            const oldMdPublish = stripInlineTagsFromMarkdown(oldMdRaw);
            item.diffOld = normaliseTextForDiff(oldMdPublish);
            item.diffNew = normaliseTextForDiff(mdPublish);
          } else {
            item.diffOld = "";
            item.diffNew = normaliseTextForDiff(mdPublish);
            item.reason +=
              " (No markdown snapshot yet — showing cleaned note only.)";
          }

          if (!needsUpdate) {
            item.action = "skip";
            item.selected = false;
            item.hasDiff = false;
            item.reason = oldStorageSnap
              ? "Found page by title, but unchanged since last export (storage snapshot baseline)."
              : "Found page by title, but content is unchanged (normalized).";
          } else {
            item.action = "update";
            item.selected = true;
            item.hasDiff = true;
            item.reason = contentDiffers
              ? oldStorageSnap
                ? "Found page by title; differs from last export (storage snapshot baseline)."
                : "Found page by title; content differs (normalized)."
              : "Found page by title; labels changed (tag-only change).";
          }
        } else {
          item.action = "create";
          item.selected = true;
          item.hasDiff = false;
          item.reason = "No mapping found; no existing page by title in space.";
        }
      } catch (e: any) {
        item.action = "skip";
        item.selected = false;
        item.hasDiff = false;
        item.reason = `Search failed: ${e?.message ?? e}`;
      }
    }

    if (item.action === "skip") item.selected = false;
    items.push(item);
  }

  return items;
}
