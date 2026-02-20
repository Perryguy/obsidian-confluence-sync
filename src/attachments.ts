// src/attachments.ts
import { App, TFile } from "obsidian";
import type {
  ConfluenceClient,
  ConfluenceAttachment,
} from "./confluenceClient";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function extractEmbeddedFiles(markdown: string): string[] {
  const out = new Set<string>();

  // Obsidian embeds: ![[...]]
  for (const m of markdown.matchAll(
    /!\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g,
  )) {
    out.add(m[1].trim());
  }

  // Markdown images: ![alt](path)
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

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function byteLength(data: ArrayBuffer): number {
  return data.byteLength ?? new Uint8Array(data).byteLength;
}

/**
 * Upload embedded images as Confluence attachments, but only when they changed.
 *
 * Returns filenames that were uploaded (changed).
 */
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

    const filename = dest.name;

    let localData: ArrayBuffer;
    try {
      localData = await app.vault.readBinary(dest);
    } catch (e: any) {
      console.warn(`[Confluence] Failed to read embed "${filename}":`, e);
      continue;
    }

    const localSize = byteLength(localData);
    const localHash = await sha256Hex(localData);

    try {
      // 1) Look up existing attachment by filename (latest version)
      const existing: ConfluenceAttachment | null =
        await client.getAttachmentByFilename(pageId, filename);

      if (!existing) {
        await client.uploadAttachment(pageId, filename, localData);
        uploaded.push(filename);
        console.log("[Confluence] Uploaded new attachment:", filename);
        continue;
      }

      // 2) Compare hashes by downloading bytes (best)
      let remoteHash: string | null = null;
      let remoteSize: number | null =
        (existing.extensions?.fileSize as number | undefined) ?? null;

      try {
        const remoteBytes = await client.downloadAttachmentBytes(existing);
        remoteHash = await sha256Hex(remoteBytes);
        remoteSize = byteLength(remoteBytes);
      } catch (e: any) {
        // If we can’t download bytes (auth/proxy), fall back to metadata size check
        console.warn(
          `[Confluence] Could not download existing attachment bytes for "${filename}" (falling back to size):`,
          e?.message ?? e,
        );
      }

      // 3) Decide upload
      if (remoteHash && remoteHash === localHash) {
        console.log(
          "[Confluence] Attachment unchanged (hash match):",
          filename,
        );
        continue;
      }

      if (!remoteHash && remoteSize != null && remoteSize === localSize) {
        console.log(
          "[Confluence] Attachment assumed unchanged (size match):",
          filename,
        );
        continue;
      }

      await client.uploadAttachment(pageId, filename, localData);
      uploaded.push(filename);
      console.log("[Confluence] Uploaded updated attachment:", filename);
    } catch (e: any) {
      console.warn(
        `[Confluence] Attachment upload failed for "${filename}" (continuing):`,
        e,
      );
      continue;
    }
  }

  return uploaded;
}
