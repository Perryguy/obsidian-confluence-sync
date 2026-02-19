import { App, TFile } from "obsidian";
import type { ConfluenceClient } from "./confluenceClient";
import type { ExportPlanItem } from "./exportPlan";

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

export interface BuildPlanOptions {
  spaceKey: string;
  /** Optional parent page id for *this export* */
  parentPageId?: string;
}

function escapeCqlString(s: string): string {
  // CQL string escaping for backslashes and quotes
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function buildExportPlan(
  deps: PlanBuilderDeps,
  files: TFile[],
  opts: BuildPlanOptions,
): Promise<ExportPlanItem[]> {
  const items: ExportPlanItem[] = [];
  const spaceKey = opts.spaceKey?.trim();
  const parentPageId = opts.parentPageId?.trim() || undefined;

  if (!spaceKey) {
    // If no space key, everything becomes skip (UI will show why)
    return files.map((f) => ({
      filePath: f.path,
      title: f.basename,
      selected: false,
      action: "skip",
      reason: "No Space Key set for this export.",
    }));
  }

  for (const file of files) {
    const title = file.basename;
    const mapped = deps.mapping.get(file.path);

    const item: ExportPlanItem = {
      filePath: file.path,
      title,
      selected: true,
      action: "create",
      reason: "No mapping found.",
    };

    // 1) If mapped, prefer that first
    if (mapped?.pageId) {
      try {
        // We want ancestors/space if possible. If your client.getPage doesn't expand,
        // it should still return 200/404 and links; plan still works.
        const page: any = await deps.client.getPage(mapped.pageId);

        item.action = "update";
        item.pageId = String(page.id);
        item.webui = page?._links?.webui
          ? deps.client.toWebUrl(page._links.webui)
          : mapped.webui;

        // Optional: detect parent mismatch if ancestors are available
        if (parentPageId && Array.isArray(page?.ancestors)) {
          const underParent = page.ancestors.some(
            (a: any) => String(a?.id) === parentPageId,
          );
          if (!underParent) {
            // It's a real page, but not under chosen parent → conflict
            item.action = "conflict";
            item.selected = false;
            item.conflictPageId = item.pageId;
            item.conflictWebui = item.webui;
            item.pageId = undefined;
            item.webui = undefined;
            item.reason =
              "Mapping points to an existing page, but it is not under the chosen Parent Page.";
          } else {
            item.reason = "Mapping exists; page found.";
          }
        } else {
          item.reason = "Mapping exists; page found.";
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes(" 404")) {
          item.action = "recreate";
          item.pageId = mapped.pageId;
          item.reason =
            "Mapping exists but page was deleted (404). Will recreate.";
        } else {
          item.action = "skip";
          item.selected = false;
          item.reason = `Could not verify mapped page: ${msg}`;
        }
      }

      items.push(item);
      continue;
    }

    // 2) If no mapping but updateExisting enabled, search Confluence by title
    if (deps.settings.updateExisting) {
      const escapedTitle = escapeCqlString(title);

      // If parent is set, search under parent first
      if (parentPageId) {
        const underParent = await deps.client.searchPageByTitle(
          spaceKey,
          escapedTitle,
          parentPageId,
        );

        if (underParent?.id) {
          item.action = "update";
          item.pageId = underParent.id;
          item.webui = underParent._links?.webui
            ? deps.client.toWebUrl(underParent._links.webui)
            : undefined;
          item.reason =
            "Found existing page by title under chosen Parent Page.";
          items.push(item);
          continue;
        }

        // Not under parent — check if it exists elsewhere in space
        const anywhere = await deps.client.searchPageByTitle(
          spaceKey,
          escapedTitle,
        );
        if (anywhere?.id) {
          item.action = "conflict";
          item.selected = false;
          item.conflictPageId = anywhere.id;
          item.conflictWebui = anywhere._links?.webui
            ? deps.client.toWebUrl(anywhere._links.webui)
            : undefined;
          item.reason =
            "A page with this title already exists in the space, but not under the chosen Parent Page.";
          items.push(item);
          continue;
        }

        // Not found anywhere — create under parent (normal create)
        item.action = "create";
        item.reason =
          "No existing page found under Parent Page (or elsewhere in space).";
        items.push(item);
        continue;
      }

      // No parent set → regular space-wide title search
      const found = await deps.client.searchPageByTitle(spaceKey, escapedTitle);
      if (found?.id) {
        item.action = "update";
        item.pageId = found.id;
        item.webui = found._links?.webui
          ? deps.client.toWebUrl(found._links.webui)
          : undefined;
        item.reason = "Found existing page by title search in space.";
        items.push(item);
        continue;
      }
    }

    // default create
    items.push(item);
  }

  return items;
}
