import type { Plugin } from "obsidian";

export interface MappingEntry {
  filePath: string;
  pageId: string;
  title: string;
  webui?: string;
  updatedAt: string;
}

type MappingStore = Record<string, MappingEntry>;

export class MappingService {
  private store: MappingStore = {};

  constructor(private plugin: Plugin) {}

  async load(): Promise<void> {
    const data = (await this.plugin.loadData()) ?? {};
    const mapping = (data as any).mapping;

    if (mapping && typeof mapping === "object") {
      this.store = mapping as MappingStore;
    } else {
      this.store = {};
    }
  }

  async save(): Promise<void> {
    const data = (await this.plugin.loadData()) ?? {};

    // Preserve anything else stored in plugin data (including settings)
    await this.plugin.saveData({
      ...data,
      mapping: this.store,
    });
  }

  get(path: string): MappingEntry | undefined {
    return this.store[path];
  }

  set(entry: MappingEntry): void {
    this.store[entry.filePath] = entry;
  }

  remove(path: string): void {
    delete this.store[path];
  }

  async reset(): Promise<void> {
    this.store = {};
    await this.save();
  }

  all(): MappingEntry[] {
    return Object.values(this.store);
  }
}
