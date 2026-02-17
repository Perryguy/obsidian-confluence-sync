export type ExportMode = "backlinks" | "outlinks" | "graph";

export type ConfluenceMode = "auto" | "cloud" | "selfHosted";
export type ConfluenceAuthMode = "basic" | "bearer";

export interface ConfluenceSettings {
  baseUrl: string;                 // cloud: https://site.atlassian.net OR https://site.atlassian.net/wiki
                                  // self-hosted: https://confluence.company OR https://host/confluence
  mode: ConfluenceMode;            // auto recommended

  authMode: ConfluenceAuthMode;    // basic or bearer
  username: string;                // basic: cloud email OR self-hosted username
  passwordOrToken: string;         // basic: cloud API token OR self-hosted password/token
  bearerToken: string;             // bearer: PAT token

  restApiPathOverride: string;     // optional: "/wiki/rest/api" or "/confluence/rest/api" or "/rest/api"

  spaceKey: string;
  parentPageId?: string;

  exportMode: ExportMode;
  graphDepth: number;

  updateExisting: boolean;
  storeContentProperties: boolean;

  mappingFileName: string;
}
