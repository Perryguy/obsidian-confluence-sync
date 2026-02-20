// src/snapshots.ts
import { App, TAbstractFile, TFile, TFolder } from "obsidian";

export class SnapshotService {
  private readonly rootFolder = ".confluence-sync";
  private readonly mdFolder = `${this.rootFolder}/snapshots`;
  private readonly storageFolder = `${this.rootFolder}/storage-snapshots`;

  constructor(private app: App) {}

  // -----------------------------
  // Public: Markdown snapshots
  // -----------------------------
  async hasSnapshot(filePath: string): Promise<boolean> {
    const p = this.mdSnapshotPath(filePath);
    return await this.app.vault.adapter.exists(p);
  }

  async readSnapshot(filePath: string): Promise<string | null> {
    const p = this.mdSnapshotPath(filePath);
    const exists = await this.app.vault.adapter.exists(p);
    if (!exists) return null;
    return await this.app.vault.adapter.read(p);
  }

  async writeSnapshot(filePath: string, markdown: string): Promise<void> {
    await this.ensureFolder(this.rootFolder);
    await this.ensureFolder(this.mdFolder);

    const p = this.mdSnapshotPath(filePath);
    // ✅ adapter.write overwrites even if Obsidian index is stale
    await this.app.vault.adapter.write(p, markdown ?? "");
  }

  // -----------------------------
  // Public: Storage snapshots
  // -----------------------------
  async hasStorageSnapshot(filePath: string): Promise<boolean> {
    const p = this.storageSnapshotPath(filePath);
    return await this.app.vault.adapter.exists(p);
  }

  async readStorageSnapshot(filePath: string): Promise<string | null> {
    const p = this.storageSnapshotPath(filePath);
    const exists = await this.app.vault.adapter.exists(p);
    if (!exists) return null;
    return await this.app.vault.adapter.read(p);
  }

  async writeStorageSnapshot(filePath: string, storage: string): Promise<void> {
    await this.ensureFolder(this.rootFolder);
    await this.ensureFolder(this.storageFolder);

    const p = this.storageSnapshotPath(filePath);
    await this.app.vault.adapter.write(p, storage ?? "");
  }

  // -----------------------------
  // Internals: Paths
  // -----------------------------
  private mdSnapshotPath(originalPath: string): string {
    const base = this.makeStableName(originalPath);
    return `${this.mdFolder}/${base}.md`;
  }

  private storageSnapshotPath(originalPath: string): string {
    const base = this.makeStableName(originalPath);
    return `${this.storageFolder}/${base}.html`;
  }

  /**
   * Stable collision-proof name.
   * NOTE: We lower-case the input BEFORE hashing to avoid Windows case issues.
   */
  private makeStableName(originalPath: string): string {
    const norm = (originalPath ?? "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .trim();

    const normLower = norm.toLowerCase();

    const slug = normLower
      .replace(/[^a-z0-9/_ .-]/g, "")
      .replace(/[\/\s]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);

    const hash = this.fnv1a32(normLower);
    return `${slug || "note"}-${hash}`;
  }

  private fnv1a32(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  // -----------------------------
  // Internals: Folder creation
  // -----------------------------
  private async ensureFolder(path: string): Promise<void> {
    const p = (path ?? "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (!p) return;

    // adapter.exists is more truthful than getAbstractFileByPath
    const exists = await this.app.vault.adapter.exists(p);
    if (exists) {
      // If it's a file, that's a hard error
      const af: TAbstractFile | null = this.app.vault.getAbstractFileByPath(p);
      if (af && !(af instanceof TFolder)) {
        throw new Error(
          `Cannot create folder "${p}" because a file exists there.`,
        );
      }
      // If Obsidian hasn't indexed it as a folder yet, still safe to return.
      return;
    }

    // ensure parent first
    const parent = p.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);

    try {
      await this.app.vault.createFolder(p);
    } catch (e: any) {
      const msg = String(e?.message ?? e).toLowerCase();
      if (msg.includes("already exists")) return;
      throw e;
    }
  }
}
