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
    .join("\n");
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

        // Current file markdown + new storage
        const md = await deps.app.vault.read(file);
        const newStorage = converter.convert(md, {
          spaceKey: ctx.spaceKey,
          fromPath: file.path,
          resolveWikiLink,
        });

        // Normalise new storage
        const b = normaliseStorage(newStorage);

        // Prefer our last-exported storage snapshot as baseline.
        // This avoids Confluence canonicalisation causing perpetual diffs.
        const oldStorageSnap = await snapshots.readStorageSnapshot?.(file.path);
        const a = oldStorageSnap ?? normaliseStorage(existingStorage);

        item.pageId = String(page.id);
        item.webui = page._links?.webui
          ? deps.client.toWebUrl(page._links.webui)
          : mapped.webui;

        // Title change awareness (never skip if title changed)
        const existingTitle = String(page?.title ?? mapped.title ?? title);
        item.existingTitle = existingTitle;
        item.titleChanged = existingTitle !== title;

        const contentDiffers = a !== b;

        // Snapshot awareness (markdown snapshot for nicer diffs)
        const snapMdExists = await snapshots.hasSnapshot(file.path);
        item.hasSnapshot = snapMdExists;

        // Provide diff text:
        // - Prefer snapshot markdown diff (best UX)
        // - Otherwise diff normalised storage vs normalised storage
        if (snapMdExists) {
          const oldMd = (await snapshots.readSnapshot(file.path)) ?? "";
          item.diffOld = normaliseTextForDiff(oldMd);
          item.diffNew = normaliseTextForDiff(md);
        } else {
          item.diffOld = normaliseTextForDiff(a);
          item.diffNew = normaliseTextForDiff(b);
        }

        // Decide action
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

          // For recreate: diff = snapshot markdown vs current markdown if available
          const snapMdExists = await snapshots.hasSnapshot(file.path);
          item.hasSnapshot = snapMdExists;

          const md = await deps.app.vault.read(file);

          item.diffOld = normaliseTextForDiff(
            snapMdExists
              ? ((await snapshots.readSnapshot(file.path)) ?? "")
              : "",
          );
          item.diffNew = normaliseTextForDiff(md);

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
          // Fetch storage so we can correctly detect "no changes"
          const page = await deps.client.getPageWithStorage(found.id);
          const existingStorage = page?.body?.storage?.value ?? "";

          const md = await deps.app.vault.read(file);
          const newStorage = converter.convert(md, {
            spaceKey: ctx.spaceKey,
            fromPath: file.path,
            resolveWikiLink,
          });

          const b = normaliseStorage(newStorage);

          // Prefer last-exported storage snapshot baseline if it exists.
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
            item.diffNew = normaliseTextForDiff(md);
          } else {
            item.diffOld = normaliseTextForDiff(a);
            item.diffNew = normaliseTextForDiff(b);
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

    // belt & braces
    if (item.action === "skip") item.selected = false;

    items.push(item);
  }

  return items;
}
