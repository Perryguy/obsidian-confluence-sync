import { App, TFile } from "obsidian";
import type { ConfluenceClient } from "./confluenceClient";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function extractEmbeddedFiles(markdown: string): string[] {
  const out = new Set<string>();

  // Obsidian embeds: ![[...]]
  // Capture everything inside [[...]] up to | or ]]
  // Supports: ![[path/file.png]], ![[file.png|300]], ![[file.png|300x200]]
  for (const m of markdown.matchAll(
    /!\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g,
  )) {
    out.add(m[1].trim());
  }

  // Markdown images: ![alt](path)
  // Also strips optional title: ![alt](path "title")
  for (const m of markdown.matchAll(
    /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
  )) {
    const p = m[1].trim();
    if (!/^https?:\/\//i.test(p)) out.add(p);
  }

  return Array.from(out);
}

export function isImageFile(file: TFile): boolean {
  return IMAGE_EXTS.has(file.extension.toLowerCase());
}

export async function uploadEmbeddedImages(
  app: App,
  client: ConfluenceClient,
  pageId: string,
  fromFile: TFile,
  markdown: string,
): Promise<string[]> {
  const embeds = extractEmbeddedFiles(markdown);
  console.log("[Confluence] Embeds found:", embeds);

  if (embeds.length === 0) return [];
  const uploaded: string[] = [];

  for (const raw of embeds) {
    const dest = app.metadataCache.getFirstLinkpathDest(raw, fromFile.path);
    if (!(dest instanceof TFile)) continue;
    if (!isImageFile(dest)) continue;

    const data = await app.vault.readBinary(dest);
    await client.uploadAttachment(pageId, dest.name, data);
    uploaded.push(dest.name);
    console.log("[Confluence] Uploaded embed attachment:", dest.name);
  }

  return uploaded;
}
