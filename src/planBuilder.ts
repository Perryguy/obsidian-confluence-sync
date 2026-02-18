import { App, TFile } from "obsidian";
import type { ConfluenceClient } from "./confluenceClient";
import type { ExportPlanItem } from "./exportPlan";

export interface PlanBuilderDeps {
  app: App;
  client: ConfluenceClient;
  mapping: {
    get: (path: string) => { pageId?: string; title?: string; webui?: string } | undefined;
  };
  settings: {
    spaceKey: string;
    updateExisting: boolean;
  };
}

export async function buildExportPlan(
  deps: PlanBuilderDeps,
  files: TFile[]
): Promise<ExportPlanItem[]> {
  const items: ExportPlanItem[] = [];

  for (const file of files) {
    const title = file.basename;
    const mapped = deps.mapping.get(file.path);

    // Default
    const item: ExportPlanItem = {
      filePath: file.path,
      title,
      selected: true,
      action: "create",
      reason: "No mapping found."
    };

    if (mapped?.pageId) {
      // Check if page exists
      try {
        const page = await deps.client.getPage(mapped.pageId);
        item.action = "update";
        item.pageId = page.id;
        item.webui = page._links?.webui ? deps.client.toWebUrl(page._links.webui) : mapped.webui;
        item.reason = "Mapping exists; page found.";
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes(" 404")) {
          item.action = "recreate";
          item.pageId = mapped.pageId;
          item.reason = "Mapping exists but page was deleted (404). Will recreate.";
        } else {
          // If Confluence is down or auth fails, don’t brick the plan
          item.action = "skip";
          item.selected = false;
          item.reason = `Could not verify mapped page: ${msg}`;
        }
      }
    } else if (deps.settings.updateExisting) {
      // Title search (optional)
      const found = await deps.client.searchPageByTitle(deps.settings.spaceKey, title);
      if (found?.id) {
        item.action = "update";
        item.pageId = found.id;
        item.webui = found._links?.webui ? deps.client.toWebUrl(found._links.webui) : undefined;
        item.reason = "Found existing page by title search in space.";
      }
    }

    items.push(item);
  }

  return items;
}