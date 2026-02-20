// src/hierarchy.ts
import { App, TFile } from "obsidian";
import type { HierarchyMode, ManyToManyPolicy } from "./types";

export interface HierarchyResult {
  ordered: TFile[];
  parentPathByPath: Map<string, string | null>; // childPath -> parentPath (null = top/root)
  depthByPath: Map<string, number>;
}

/**
 * Decide hierarchy using only the export set.
 * Root is always top-level (parent null).
 */
export function buildHierarchy(
  app: App,
  root: TFile,
  files: TFile[],
  mode: HierarchyMode,
  manyToManyPolicy: ManyToManyPolicy,
): HierarchyResult {
  const fileSet = new Map<string, TFile>();
  for (const f of files) fileSet.set(f.path, f);

  const parentPathByPath = new Map<string, string | null>();
  const depthByPath = new Map<string, number>();

  // Root always top
  parentPathByPath.set(root.path, null);

  if (mode === "flat") {
    for (const f of files) {
      if (f.path === root.path) continue;
      parentPathByPath.set(f.path, root.path);
    }
    computeDepths(root.path, parentPathByPath, depthByPath);
    return {
      ordered: orderByDepthThenPath(files, depthByPath, root.path, fileSet),
      parentPathByPath,
      depthByPath,
    };
  }

  if (mode === "folder") {
    for (const f of files) {
      if (f.path === root.path) continue;
      const p = folderParentCandidate(f, fileSet);
      parentPathByPath.set(f.path, p ?? root.path);
    }
    parentPathByPath.set(root.path, null);
    resolveManyToMany(root, files, parentPathByPath, manyToManyPolicy);
    computeDepths(root.path, parentPathByPath, depthByPath);
    return {
      ordered: orderByDepthThenPath(files, depthByPath, root.path, fileSet),
      parentPathByPath,
      depthByPath,
    };
  }

  if (mode === "frontmatter") {
    for (const f of files) {
      if (f.path === root.path) continue;
      const fm = app.metadataCache.getFileCache(f)?.frontmatter;
      const parentName = (fm?.parent ?? fm?.Parent ?? fm?.confluenceParent) as
        | string
        | undefined;

      const parentPath = parentName
        ? resolveTitleToPath(app, parentName, f.path, fileSet)
        : null;

      parentPathByPath.set(f.path, parentPath ?? root.path);
    }
    parentPathByPath.set(root.path, null);
    resolveManyToMany(root, files, parentPathByPath, manyToManyPolicy);
    computeDepths(root.path, parentPathByPath, depthByPath);
    return {
      ordered: orderByDepthThenPath(files, depthByPath, root.path, fileSet),
      parentPathByPath,
      depthByPath,
    };
  }

  // links / hybrid
  for (const f of files) {
    if (f.path === root.path) continue;

    const folderP = folderParentCandidate(f, fileSet);
    const linkP = firstLinkedExportedParent(app, f, fileSet);

    const chosen =
      mode === "hybrid"
        ? (folderP ?? linkP ?? root.path)
        : (linkP ?? root.path);

    parentPathByPath.set(f.path, chosen);
  }

  parentPathByPath.set(root.path, null);

  resolveManyToMany(root, files, parentPathByPath, manyToManyPolicy);
  computeDepths(root.path, parentPathByPath, depthByPath);

  return {
    ordered: orderByDepthThenPath(files, depthByPath, root.path, fileSet),
    parentPathByPath,
    depthByPath,
  };
}

function firstLinkedExportedParent(
  app: App,
  file: TFile,
  fileSet: Map<string, TFile>,
): string | null {
  const cache = app.metadataCache.getFileCache(file);
  const links = cache?.links ?? [];
  for (const l of links) {
    const dest = app.metadataCache.getFirstLinkpathDest(l.link, file.path);
    if (dest instanceof TFile && dest.extension === "md") {
      if (fileSet.has(dest.path)) return dest.path;
    }
  }
  return null;
}

function folderParentCandidate(
  file: TFile,
  fileSet: Map<string, TFile>,
): string | null {
  const parts = file.path.split("/");
  parts.pop(); // remove filename
  while (parts.length > 0) {
    const folder = parts.join("/");
    const idx = `${folder}/index.md`;
    if (fileSet.has(idx)) return idx;

    const folderName = parts[parts.length - 1];
    const folderNote = `${folder}/${folderName}.md`;
    if (fileSet.has(folderNote)) return folderNote;

    parts.pop();
  }
  return null;
}

function resolveTitleToPath(
  app: App,
  title: string,
  fromPath: string,
  fileSet: Map<string, TFile>,
): string | null {
  const dest = app.metadataCache.getFirstLinkpathDest(title, fromPath);
  if (
    dest instanceof TFile &&
    dest.extension === "md" &&
    fileSet.has(dest.path)
  )
    return dest.path;
  return null;
}

function resolveManyToMany(
  root: TFile,
  files: TFile[],
  parentPathByPath: Map<string, string | null>,
  _policy: ManyToManyPolicy,
) {
  // Ensure every non-root has a parent within set (or root)
  for (const f of files) {
    if (f.path === root.path) continue;
    const p = parentPathByPath.get(f.path);
    if (!p) parentPathByPath.set(f.path, root.path);
  }

  // Break self-parent
  for (const [child, parent] of Array.from(parentPathByPath.entries())) {
    if (parent === child) parentPathByPath.set(child, root.path);
  }

  // Break cycles deterministically
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const breakCycle = (node: string) => {
    parentPathByPath.set(node, root.path);
  };

  const dfs = (n: string) => {
    if (visited.has(n)) return;
    if (visiting.has(n)) {
      breakCycle(n);
      return;
    }
    visiting.add(n);
    const p = parentPathByPath.get(n);
    if (p) dfs(p);
    visiting.delete(n);
    visited.add(n);
  };

  for (const f of files) dfs(f.path);
}

function computeDepths(
  rootPath: string,
  parentPathByPath: Map<string, string | null>,
  depthByPath: Map<string, number>,
) {
  depthByPath.set(rootPath, 0);

  const getDepth = (p: string): number => {
    if (depthByPath.has(p)) return depthByPath.get(p)!;
    const parent = parentPathByPath.get(p);
    if (!parent) {
      depthByPath.set(p, 0);
      return 0;
    }
    const d = getDepth(parent) + 1;
    depthByPath.set(p, d);
    return d;
  };

  for (const k of Array.from(parentPathByPath.keys())) getDepth(k);
}

function orderByDepthThenPath(
  files: TFile[],
  depthByPath: Map<string, number>,
  rootPath: string,
  fileSet: Map<string, TFile>,
): TFile[] {
  // Keep only files in set, ensure root exists
  const unique = new Map<string, TFile>();
  for (const f of files) unique.set(f.path, f);

  const root = fileSet.get(rootPath) ?? unique.get(rootPath);
  const rest = Array.from(unique.values()).filter((f) => f.path !== rootPath);

  rest.sort((a, b) => {
    const da = depthByPath.get(a.path) ?? 999;
    const db = depthByPath.get(b.path) ?? 999;
    if (da !== db) return da - db;
    return a.path.localeCompare(b.path);
  });

  return root ? [root, ...rest] : rest;
}
