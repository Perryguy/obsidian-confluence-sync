export function extractObsidianTags(markdown: string): string[] {
  const tags = new Set<string>();

  // Frontmatter tags: tags: [a, b] or tags: a
  const fm = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (fm) {
    const block = fm[1];
    const m1 = block.match(/^\s*tags\s*:\s*\[(.+?)\]\s*$/m);
    if (m1) {
      for (const raw of m1[1].split(",")) tags.add(String(raw).trim().replace(/^["']|["']$/g, ""));
    } else {
      const m2 = block.match(/^\s*tags\s*:\s*(.+?)\s*$/m);
      if (m2) tags.add(m2[1].trim().replace(/^["']|["']$/g, ""));
    }
  }

  // Inline tags: #foo #foo/bar (avoid headings like "# Title")
  for (const m of markdown.matchAll(/(^|[\s(])#([a-zA-Z0-9/_-]+)\b/g)) {
    const t = m[2];
    if (t && t.length > 0) tags.add(t);
  }

  return Array.from(tags);
}

export function toConfluenceLabel(tag: string): string {
  // Confluence labels: lowercase; usually [a-z0-9-] works well
  return tag
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
