// src/planBuilder.ts
import { App, TFile } from "obsidian";
import type { ConfluenceClient } from "./confluenceClient";
import type { ExportPlanItem } from "./exportPlan";
import { ConfluenceStorageConverter } from "./confluenceStorageConverter";
import { normaliseStorage } from "./storageNormalise";
import { SnapshotService } from "./snapshots";

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
  };
}

function normaliseTextForDiff(t: string): string {
  // Prevent "everything changed" due to CRLF vs LF or trailing whitespace.
  return (t ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

/**
 * Must match Exporter.toPublishMarkdown() behaviour (so plan === publish).
 * - removes YAML frontmatter
 * - strips inline #tags (not in code blocks / inline code)
 */
function toPublishMarkdown(markdown: string): string {
  if (!markdown) return "";

  let s = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");

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

  s = s.replace(/(^|[\s(])#([A-Za-z0-9/_-]+)\b/gm, "$1");

  s = s.replace(/@@HOLE_(\d+)@@/g, (_m, idx) => {
    const i = Number(idx);
    return Number.isFinite(i) ? (holes[i] ?? "") : "";
  });

  return normaliseTextForDiff(s);
}

export async function buildExportPlan(
  deps: PlanBuilderDeps,
  files: TFile[],
  ctx: {
    spaceKey: string;
    parentPageId?: string;
  },
): Promise<ExportPlanItem[]> {
  const items: ExportPlanItem[] = [];
  const converter = new ConfluenceStorageConverter();
  const snapshots = new SnapshotService(deps.app);

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
    };

    // ---------- CASE 1: Mapping exists ----------
    if (mapped?.pageId) {
      try {
        const page = await deps.client.getPageWithStorage(mapped.pageId);
        const existingStorage = page?.body?.storage?.value ?? "";

        const mdOriginal = await deps.app.vault.read(file);
        const mdPublish = toPublishMarkdown(mdOriginal);

        const newStorage = converter.convert(mdPublish, {
          spaceKey: ctx.spaceKey,
          fromPath: file.path,
          resolveWikiLink,
        });

        const b = normaliseStorage(newStorage);

        // Prefer last-exported storage snapshot as baseline (best stability)
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

        // Snapshot awareness (markdown snapshot stores publish-markdown)
        const snapMdExists = await snapshots.hasSnapshot(file.path);
        item.hasSnapshot = snapMdExists;

        if (snapMdExists) {
          const oldMd = (await snapshots.readSnapshot(file.path)) ?? "";
          item.diffOld = normaliseTextForDiff(oldMd);
          item.diffNew = normaliseTextForDiff(mdPublish);
          item.hasDiff = true;
        } else {
          item.diffOld = "";
          item.diffNew = normaliseTextForDiff(mdPublish);
          item.hasDiff = true;
          item.reason +=
            " (No previous publish snapshot yet — showing current publish content only.)";
        }

        if (!contentDiffers && !item.titleChanged) {
          item.action = "skip";
          item.selected = false;
          item.hasDiff = false;
          item.reason = oldStorageSnap
            ? "No content changes detected (storage snapshot baseline)."
            : "No content changes detected (normalized).";
        } else {
          item.action = "update";
          item.selected = true;
          item.hasDiff = true;
          item.reason = item.titleChanged
            ? "Title changed (will update page title)."
            : oldStorageSnap
              ? "Content differs from last export (storage snapshot baseline)."
              : "Content differs from Confluence (normalized).";
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

          const mdOriginal = await deps.app.vault.read(file);
          const mdPublish = toPublishMarkdown(mdOriginal);

          item.diffOld = normaliseTextForDiff(
            snapMdExists
              ? ((await snapshots.readSnapshot(file.path)) ?? "")
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

          const mdOriginal = await deps.app.vault.read(file);
          const mdPublish = toPublishMarkdown(mdOriginal);

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

          const snapMdExists = await snapshots.hasSnapshot(file.path);
          item.hasSnapshot = snapMdExists;

          if (snapMdExists) {
            const oldMd = (await snapshots.readSnapshot(file.path)) ?? "";
            item.diffOld = normaliseTextForDiff(oldMd);
            item.diffNew = normaliseTextForDiff(mdPublish);
          } else {
            item.diffOld = "";
            item.diffNew = normaliseTextForDiff(mdPublish);
          }

          if (!contentDiffers) {
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
            item.reason = oldStorageSnap
              ? "Found page by title; differs from last export (storage snapshot baseline)."
              : "Found page by title; content differs (normalized).";
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