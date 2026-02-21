// src/types.ts
export type ExportMode = "backlinks" | "outlinks" | "graph";
export type ConfluenceMode = "auto" | "cloud" | "selfHosted";
export type ConfluenceAuthMode = "basic" | "bearer";

export type HierarchyMode =
  | "flat"
  | "links"
  | "folder"
  | "frontmatter"
  | "hybrid";

export type ManyToManyPolicy =
  | "firstSeen"
  | "closestToRoot"
  | "preferFolderIndex";

export type LabelSyncMode = "addOnly" | "strict";

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

  dryRun: boolean;
  childPagesUnderRoot: boolean;
  showProgressNotices: boolean;

  // Defaults only — hierarchy is chosen at review time
  hierarchyMode: HierarchyMode;
  hierarchyManyToManyPolicy: ManyToManyPolicy;

  /** If true, move existing pages to match the chosen hierarchy */
  movePagesToMatchHierarchy: boolean;

  /** Label behaviour */
  labelSyncMode: LabelSyncMode; // "addOnly" (safe default) | "strict" (removes extra labels)
  includeInlineTagsForLabels: boolean; // keep inline #tags as labels (default true)
}