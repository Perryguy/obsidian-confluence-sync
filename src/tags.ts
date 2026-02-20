// src/tags.ts

function stripQuotes(s: string): string {
  return (s ?? "").trim().replace(/^["']|["']$/g, "");
}

function removeFrontmatter(markdown: string): { body: string; frontmatter: string | null } {
  const m = (markdown ?? "").match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { body: markdown ?? "", frontmatter: null };
  const fm = m[1] ?? "";
  const body = (markdown ?? "").slice(m[0].length);
  return { body, frontmatter: fm };
}

function removeCodeBlocks(s: string): string {
  // Remove fenced code blocks ```...``` and ~~~...~~~
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/~~~[\s\S]*?~~~/g, "");

  // Remove inline code `...`
  s = s.replace(/`[^`]*`/g, "");

  return s;
}

function extractFrontmatterTags(frontmatter: string): string[] {
  const tags = new Set<string>();
  const fm = frontmatter ?? "";

  // Support "tags:" or "tag:" keys
  // 1) Inline array: tags: [a, b, "c d"]
  const inlineArray = fm.match(/^\s*(tags|tag)\s*:\s*\[(.+?)\]\s*$/im);
  if (inlineArray?.[2]) {
    const raw = inlineArray[2];
    for (const part of raw.split(",")) {
      const v = stripQuotes(part);
      if (v) tags.add(v);
    }
    return Array.from(tags);
  }

  // 2) Inline scalar: tags: a  (or tags: "a")
  const inlineScalar = fm.match(/^\s*(tags|tag)\s*:\s*(.+?)\s*$/im);
  if (inlineScalar) {
    const key = inlineScalar[1]?.toLowerCase();
    const val = stripQuotes(inlineScalar[2] ?? "");

    // If it looks like a block list start, don't treat as scalar
    if (val === "" || val === "|" || val === ">" || val.startsWith("-")) {
      // fall through
    } else if (key === "tags" || key === "tag") {
      // Some people put comma-separated scalars: tags: a, b
      for (const part of val.split(",")) {
        const v = stripQuotes(part);
        if (v) tags.add(v);
      }
      // don't return yet; might ALSO have a block list below in weird YAML
    }
  }

  // 3) Block list:
  // tags:
  //   - a
  //   - b
  const blockListStart = fm.match(/^\s*(tags|tag)\s*:\s*$/im);
  if (blockListStart) {
    // Extract the section from the key line until the next top-level key
    const lines = fm.split("\n");
    const startIdx = lines.findIndex((l) => /^\s*(tags|tag)\s*:\s*$/i.test(l));
    if (startIdx >= 0) {
      for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];

        // Stop when a new top-level key starts (no indent, looks like "key:")
        if (/^[A-Za-z0-9_-]+\s*:\s*/.test(line) && !/^\s+-\s*/.test(line)) {
          break;
        }

        const m = line.match(/^\s*-\s*(.+?)\s*$/);
        if (m?.[1]) {
          const v = stripQuotes(m[1]);
          if (v) tags.add(v);
        }
      }
    }
  }

  return Array.from(tags);
}

export function extractObsidianTags(markdown: string): string[] {
  const tags = new Set<string>();

  const { body, frontmatter } = removeFrontmatter(markdown ?? "");

  // Frontmatter tags
  if (frontmatter) {
    for (const t of extractFrontmatterTags(frontmatter)) tags.add(t);
  }

  // Inline tags: #foo #foo/bar (avoid headings like "# Title")
  // Work on body only + remove code blocks to avoid false positives
  const cleaned = removeCodeBlocks(body);

  for (const m of cleaned.matchAll(/(^|[\s(])#([A-Za-z0-9/_-]+)\b/g)) {
    const t = m[2];
    if (!t) continue;

    // Avoid capturing Markdown heading markers like "# Title"
    // (this regex already requires whitespace or "(" before "#", so headings at SOL won't match unless there is leading whitespace)
    // Still, belt-and-braces: reject if immediately followed by space (common heading)
    // Example: "# Title" would be captured only if pattern hits, but it's rare; keep extra guard.
    // Note: "#title" is a valid tag.
    tags.add(t);
  }

  return Array.from(tags);
}

export function toConfluenceLabel(tag: string): string {
  // Confluence labels: lower-case; typically [a-z0-9-] is safest
  // Practical cap: 255 chars (keeps API happy)
  const s = (tag ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return s.slice(0, 255);
}