// src/confluenceClient.ts
import { requestUrl, RequestUrlParam } from "obsidian";

type HttpMethod = "GET" | "POST" | "PUT";

export type ConfluenceMode = "auto" | "cloud" | "selfHosted";
export type ConfluenceAuthMode = "basic" | "bearer";

export interface ConfluenceClientSettings {
  baseUrl: string;                 // e.g. https://confluence.company.net OR https://site.atlassian.net/wiki
  mode: ConfluenceMode;            // auto recommended
  authMode: ConfluenceAuthMode;    // bearer or basic
  username?: string;               // basic: cloud email or selfhost username
  passwordOrToken?: string;        // basic: cloud api token or selfhost password/token
  bearerToken?: string;            // bearer: PAT
  restApiPathOverride?: string;    // optional override like "/confluence/rest/api" or "/wiki/rest/api"
}

export interface ConfluencePage {
  id: string;
  title: string;
  version: { number: number };
}

export class ConfluenceClient {
  private restRoot: string | null = null;

  constructor(private s: ConfluenceClientSettings) {}

  private base(): string {
    return this.s.baseUrl.replace(/\/+$/, "");
  }

  private authHeaders(): Record<string, string> {
    if (this.s.authMode === "bearer") {
      if (!this.s.bearerToken) throw new Error("Bearer token missing.");
      return { Authorization: `Bearer ${this.s.bearerToken}` };
    }
    // basic
    if (!this.s.username || !this.s.passwordOrToken) throw new Error("Username/password-or-token missing.");
    const basic = btoa(`${this.s.username}:${this.s.passwordOrToken}`);
    return { Authorization: `Basic ${basic}` };
  }

  private candidateRestRoots(): string[] {
    const base = this.base();

    // If user overrides, trust it first.
    if (this.s.restApiPathOverride?.trim()) {
      const p = this.s.restApiPathOverride.startsWith("/")
        ? this.s.restApiPathOverride
        : `/${this.s.restApiPathOverride}`;
      return [`${base}${p}`];
    }

    // Detect "cloud-ish" by domain and/or explicit mode.
    const looksCloud = base.includes("atlassian.net");
    const mode = this.s.mode;

    const roots: string[] = [];

    const add = (suffix: string) => roots.push(`${base}${suffix}`);

    if (mode === "cloud" || (mode === "auto" && looksCloud)) {
      // Cloud commonly uses /wiki/rest/api
      if (base.endsWith("/wiki")) add("/rest/api");
      else add("/wiki/rest/api");
      add("/rest/api"); // fallback
      return dedupe(roots);
    }

    // Self-hosted default
    add("/rest/api");
    add("/wiki/rest/api"); // fallback if their reverse proxy exposes /wiki
    return dedupe(roots);

    function dedupe(arr: string[]) {
      return Array.from(new Set(arr.map(x => x.replace(/\/+$/, ""))));
    }
  }

  private async ensureRestRoot(): Promise<string> {
    if (this.restRoot) return this.restRoot;

    const candidates = this.candidateRestRoots();

    // probe each candidate using a lightweight endpoint
    const errors: string[] = [];

    for (const root of candidates) {
      try {
        await this.rawCall<any>("GET", `${root}/space?limit=1`, undefined, true);
        this.restRoot = root;
        return root;
      } catch (e: any) {
        errors.push(`${root} -> ${e?.message ?? e}`);
      }
    }

    throw new Error(
      `Could not detect Confluence REST API root. Tried:\n` +
      errors.map(x => `- ${x}`).join("\n") +
      `\n\nIf you are self-hosted behind a context path (e.g. /confluence), set REST API path override to something like "/confluence/rest/api".`
    );
  }

  private async rawCall<T>(
    method: HttpMethod,
    url: string,
    body?: any,
    noJsonParse?: boolean
  ): Promise<T> {
    const req: RequestUrlParam = {
      url,
      method,
      headers: {
        ...this.authHeaders(),
        "Accept": "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    };

    const res = await requestUrl(req);
    if (res.status >= 400) throw new Error(`${method} ${url} failed: ${res.status} ${res.text}`);
    return (noJsonParse ? ({} as T) : (res.json as T));
  }

  private async call<T>(method: HttpMethod, path: string, body?: any): Promise<T> {
    const root = await this.ensureRestRoot();
    const url = `${root}${path}`;
    return this.rawCall<T>(method, url, body);
  }

  // ---- Public API ----

  async ping(): Promise<string> {
    const root = await this.ensureRestRoot();
    return root;
  }

  async searchPageByTitle(spaceKey: string, title: string): Promise<ConfluencePage | null> {
    const cql = `type=page AND space="${spaceKey}" AND title="${title.replace(/"/g, '\\"')}"`;
    const result = await this.call<{ results: ConfluencePage[] }>(
      "GET",
      `/content/search?cql=${encodeURIComponent(cql)}&expand=version`
    );
    return result.results?.[0] ?? null;
  }

  async getPage(pageId: string): Promise<ConfluencePage> {
    return this.call<ConfluencePage>("GET", `/content/${pageId}?expand=version`);
  }

  async createPage(spaceKey: string, title: string, parentId: string | undefined, storageValue: string): Promise<ConfluencePage> {
    const body: any = {
      type: "page",
      title,
      space: { key: spaceKey },
      body: { storage: { value: storageValue, representation: "storage" } }
    };
    if (parentId) body.ancestors = [{ id: parentId }];
    return this.call<ConfluencePage>("POST", `/content`, body);
  }

  async updatePage(pageId: string, title: string, storageValue: string): Promise<ConfluencePage> {
    const current = await this.getPage(pageId);
    const nextVersion = (current.version?.number ?? 1) + 1;

    const body = {
      id: pageId,
      type: "page",
      title,
      version: { number: nextVersion },
      body: { storage: { value: storageValue, representation: "storage" } }
    };

    return this.call<ConfluencePage>("PUT", `/content/${pageId}`, body);
  }
}
