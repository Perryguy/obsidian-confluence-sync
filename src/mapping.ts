import { App, TFile } from "obsidian";
import type { MappingStore, MappingEntry } from "./types";

const DEFAULT_MAPPING: MappingStore = {
  version: 1,
  entries: {}
};

export class MappingService {
  private store: MappingStore = { ...DEFAULT_MAPPING };

  constructor(private app: App, private mappingFileName: string) {}

  getStore(): MappingStore {
    return this.store;
  }

  get(filePath: string): MappingEntry | undefined {
    return this.store.entries[filePath];
  }

  set(entry: MappingEntry): void {
    this.store.entries[entry.filePath] = entry;
  }

  async load(): Promise<void> {
    const path = this.mappingFileName;
    const af = this.app.vault.getAbstractFileByPath(path);

    if (!af) {
      await this.app.vault.create(path, JSON.stringify(DEFAULT_MAPPING, null, 2));
      this.store = { ...DEFAULT_MAPPING };
      return;
    }

    const file = af as TFile;
    const text = await this.app.vault.read(file);
    try {
      this.store = JSON.parse(text) as MappingStore;
      if (!this.store.version) this.store.version = 1;
      if (!this.store.entries) this.store.entries = {};
    } catch {
      // If corrupted, do not destroy it automatically — just fall back in-memory
      this.store = { ...DEFAULT_MAPPING };
    }
  }

  async save(): Promise<void> {
    const path = this.mappingFileName;
    const af = this.app.vault.getAbstractFileByPath(path);

    const payload = JSON.stringify(this.store, null, 2);

    if (!af) {
      await this.app.vault.create(path, payload);
      return;
    }

    await this.app.vault.modify(af as TFile, payload);
  }
}