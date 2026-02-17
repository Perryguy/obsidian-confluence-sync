export type ExportMode = "backlinks" | "outlinks" | "graph";
export type ConfluenceMode = "auto" | "cloud" | "selfHosted";
export type ConfluenceAuthMode = "basic" | "bearer";

export interface ConfluenceSettings {
  baseUrl: string;
  mode: ConfluenceMode;

  authMode: ConfluenceAuthMode;
  username: string;
  passwordOrToken: string;
  bearerToken: string;

  restApiPathOverride: string;

  spaceKey: string;
  parentPageId?: string;

  exportMode: ExportMode;
  graphDepth: number;

  updateExisting: boolean;
  storeContentProperties: boolean;

  mappingFileName: string; // e.g. confluence-mapping.json
}

export interface MappingEntry {
  filePath: string;     // Obsidian path
  pageId: string;       // Confluence content id
  title: string;        // Confluence page title
  webui?: string;       // Relative UI link returned by API (preferred for linking)
  updatedAt?: string;
}

export interface MappingStore {
  version: number;
  entries: Record<string, MappingEntry>; // key = filePath
}