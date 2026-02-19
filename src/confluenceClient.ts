// src/confluenceClient.ts
import { requestUrl, type RequestUrlResponse } from "obsidian";

type ConfluenceMode = "auto" | "cloud" | "selfHosted";
type ConfluenceAuthMode = "basic" | "bearer";

export interface ConfluenceClientConfig {
  baseUrl: string; // Cloud: https://site.atlassian.net/wiki   OR https://site.atlassian.net (we'll handle)
  mode: ConfluenceMode;

  authMode: ConfluenceAuthMode;
  username: string;
  passwordOrToken: string; // basic: password or cloud api token
  bearerToken: string; // bearer: PAT

  restApiPathOverride?: string; // "", "/wiki/rest/api", "/rest/api", "/confluence/rest/api", etc.
}

export interface ConfluenceLinks {
  webui?: string;
  tinyui?: string;
  self?: string;
}

export interface ConfluenceContent {
  id: string;
  type?: string;
  title: string;
  _links?: ConfluenceLinks;
  version?: { number: number };
}

function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}
function ensureLeadingSlash(s: string): string {
  if (!s) return "";
  return s.startsWith("/") ? s : `/${s}`;
}

export class ConfluenceClient {
  private restRootCache?: string;

  constructor(private cfg: ConfluenceClientConfig) {}

  /**
   * Escape a string for safe inclusion inside a double-quoted CQL string literal.
   * Escapes backslashes first, then double quotes.
   */
  private escapeCqlStringLiteral(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // ---------------------------
  // Public API used by exporter
  // ---------------------------

  async ping(): Promise<string> {
    const root = await this.ensureRestRoot();
    // A lightweight endpoint that exists on both Cloud and DC/Server
    await this.rawCall("GET", `${root}/space?limit=1`);
    return root;
  }

  async searchPageByTitle(
    spaceKey: string,
    title: string,
  ): Promise<ConfluenceContent | null> {
    const root = await this.ensureRestRoot();
    const q = `type=page AND space="${spaceKey}" AND title="${this.escapeCqlStringLiteral(title)}"`;
    const url = `${root}/content/search?cql=${encodeURIComponent(q)}&limit=1`;

    const res = await this.rawCall("GET", url);
    const json = this.safeJson(res.text);
    const r = json?.results?.[0];
    if (!r?.id) return null;
    return {
      id: String(r.id),
      title: String(r.title ?? title),
      _links: r._links,
      version: r.version,
    };
  }

  async createPage(
    spaceKey: string,
    title: string,
    parentPageId: string | undefined,
    storageValue: string,
  ): Promise<ConfluenceContent> {
    const root = await this.ensureRestRoot();
    const body: any = {
      type: "page",
      title,
      space: { key: spaceKey },
      body: { storage: { value: storageValue, representation: "storage" } },
    };

    if (parentPageId) {
      body.ancestors = [{ id: parentPageId }];
    }

    const res = await this.rawCall("POST", `${root}/content`, body);
    const json = this.safeJson(res.text);

    return {
      id: String(json?.id),
      title: String(json?.title ?? title),
      _links: json?._links,
      version: json?.version,
    };
  }

  async updatePage(
    pageId: string,
    title: string,
    storageValue: string,
  ): Promise<ConfluenceContent> {
    const root = await this.ensureRestRoot();

    // Need current version
    const currentRes = await this.rawCall(
      "GET",
      `${root}/content/${pageId}?expand=version`,
    );
    const current = this.safeJson(currentRes.text);
    const currentVersion = Number(current?.version?.number ?? 1);

    const body = {
      id: pageId,
      type: "page",
      title,
      version: { number: currentVersion + 1 },
      body: { storage: { value: storageValue, representation: "storage" } },
    };

    const res = await this.rawCall("PUT", `${root}/content/${pageId}`, body);
    const json = this.safeJson(res.text);

    return {
      id: String(json?.id ?? pageId),
      title: String(json?.title ?? title),
      _links: json?._links,
      version: json?.version,
    };
  }

  /**
   * Confluence Cloud attachments:
   * PUT /wiki/rest/api/content/{id}/child/attachment
   * Must include X-Atlassian-Token: nocheck for multipart/form-data.
   *
   * We use requestUrl + a manually-built multipart body to avoid CORS.
   */
  async uploadAttachment(
    pageId: string,
    filename: string,
    data: ArrayBuffer,
  ): Promise<void> {
    const root = await this.ensureRestRoot();
    const url = `${root}/content/${pageId}/child/attachment`;
    const safeName = filename.replace(/[\r\n"]/g, "_");
    const boundary = `----WebKitFormBoundary${Math.random().toString(16).slice(2)}${Date.now()}`;
    const mime = this.guessMime(safeName);
    const bodyBytes = this.buildMultipartBody(safeName, mime, data, boundary);

    const res = await requestUrl({
      url,
      method: "PUT",
      headers: {
        Accept: "application/json",
        "User-Agent": "Obsidian.md",
        ...this.authHeaders(),
        "X-Atlassian-Token": "nocheck",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: bodyBytes.buffer as any,
      throw: false,
    });

    if (res.status >= 400) {
      // Now you'll finally see Atlassian's actual error message in res.text
      throw new Error(`POST ${url} failed: ${res.status} ${res.text}`);
    }
  }

  // ---------------------------
  // REST root detection
  // ---------------------------

  async ensureRestRoot(): Promise<string> {
    if (this.restRootCache) return this.restRootCache;

    const base = stripTrailingSlashes(this.cfg.baseUrl);
    const override = (this.cfg.restApiPathOverride ?? "").trim();

    if (override) {
      // If they put full "/wiki/rest/api" or "/rest/api", honor it
      const rest = `${base}${ensureLeadingSlash(override)}`.replace(/\/+$/, "");
      // Probe quickly
      await this.rawCall("GET", `${rest}/space?limit=1`);
      this.restRootCache = rest;
      return rest;
    }

    // Candidate list
    const candidates: string[] = [];

    // If base already includes /wiki, treat it as Cloud base and try /rest/api
    if (base.endsWith("/wiki")) {
      candidates.push(`${base}/rest/api`);
    } else {
      // Cloud
      candidates.push(`${base}/wiki/rest/api`);
      // Self-hosted common
      candidates.push(`${base}/rest/api`);
      candidates.push(`${base}/confluence/rest/api`);
    }

    // Mode filtering
    const mode = this.cfg.mode;
    const filtered =
      mode === "cloud"
        ? candidates.filter((c) => c.includes("/wiki/"))
        : mode === "selfHosted"
          ? candidates.filter((c) => !c.includes("/wiki/"))
          : candidates;

    const errors: string[] = [];

    for (const rest of filtered) {
      try {
        await this.rawCall("GET", `${rest}/space?limit=1`);
        this.restRootCache = rest;
        return rest;
      } catch (e: any) {
        errors.push(`${rest}/space?limit=1 -> ${e?.message ?? e}`);
      }
    }

    throw new Error(
      `Could not detect Confluence REST root. Tried:\n${errors.join("\n")}`,
    );
  }

  async addLabels(pageId: string, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const root = await this.ensureRestRoot();
    const url = `${root}/content/${pageId}/label`;

    const body = labels.map((name) => ({ prefix: "global", name }));

    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        Accept: "application/json",
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    });

    if (res.status >= 400) {
      throw new Error(`POST ${url} failed: ${res.status} ${res.text}`);
    }
  }

  // ---------------------------
  // Low-level HTTP helpers
  // ---------------------------

  private authHeaders(): Record<string, string> {
    if (this.cfg.authMode === "bearer") {
      const token = (this.cfg.bearerToken ?? "").trim();
      return token ? { Authorization: `Bearer ${token}` } : {};
    }

    // basic
    const user = this.cfg.username ?? "";
    const pass = this.cfg.passwordOrToken ?? "";
    const encoded = btoa(`${user}:${pass}`);
    return { Authorization: `Basic ${encoded}` };
  }

  private async rawCall(
    method: "GET" | "POST" | "PUT",
    url: string,
    jsonBody?: any,
  ): Promise<RequestUrlResponse> {
    // requestUrl bypasses CORS (good for Obsidian desktop)
    const res = await requestUrl({
      url,
      method,
      headers: {
        ...this.authHeaders(),
        Accept: "application/json",
        ...(jsonBody ? { "Content-Type": "application/json" } : {}),
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    });

    if (res.status >= 400) {
      throw new Error(`${method} ${url} failed: ${res.status} ${res.text}`);
    }
    return res;
  }

  private safeJson(text: string): any {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private guessMime(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "png":
        return "image/png";
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "gif":
        return "image/gif";
      case "webp":
        return "image/webp";
      case "svg":
        return "image/svg+xml";
      default:
        return "application/octet-stream";
    }
  }

  /**
   * Builds a multipart/form-data body with:
   *  - comment field
   *  - file field
   *
   * Returns Uint8Array so requestUrl won't coerce it to string.
   */
  private buildMultipartBody(
    filename: string,
    mime: string,
    data: ArrayBuffer,
    boundary: string,
  ): Uint8Array {
    const enc = new TextEncoder();

    // IMPORTANT: file field name must be exactly "file"
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n` +
      `\r\n`;

    const tail = `\r\n--${boundary}--\r\n`;

    const headBytes = enc.encode(head);
    const fileBytes = new Uint8Array(data);
    const tailBytes = enc.encode(tail);

    const out = new Uint8Array(
      headBytes.length + fileBytes.length + tailBytes.length,
    );
    out.set(headBytes, 0);
    out.set(fileBytes, headBytes.length);
    out.set(tailBytes, headBytes.length + fileBytes.length);

    return out;
  }

  async getPage(pageId: string) {
    const root = await this.ensureRestRoot();
    const res = await requestUrl({
      url: `${root}/content/${pageId}?expand=version,_links`,
      method: "GET",
      headers: { Accept: "application/json", ...this.authHeaders() },
      throw: false,
    });

    if (res.status >= 400)
      throw new Error(
        `GET content/${pageId} failed: ${res.status} ${res.text}`,
      );
    return JSON.parse(res.text);
  }

  // Confluence returns _links.webui like "/spaces/KEY/pages/123/Title"
  toWebUrl(webuiPath: string): string {
    // Derive site base from cfg.baseUrl
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    if (webuiPath.startsWith("http")) return webuiPath;
    return `${base}${webuiPath.startsWith("/") ? "" : "/"}${webuiPath}`;
  }
}
