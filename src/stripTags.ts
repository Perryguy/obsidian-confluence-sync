// src/stripTags.ts
export function stripInlineTagsFromMarkdown(markdown: string): string {
  if (!markdown) return "";

  // Normalise BOM + line endings (Windows CRLF etc.)
  markdown = markdown
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // Remove YAML frontmatter at top of file.
  // Allows leading whitespace/blank lines before the first ---.
  // (If you DO want frontmatter in Confluence, delete this block.)
  markdown = markdown.replace(/^\s*---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");

  // Remove fenced code blocks and inline code temporarily by tokenizing
  const codeSpans: string[] = [];
  markdown = markdown.replace(/```[\s\S]*?```/g, (m) => {
    codeSpans.push(m);
    return `@@CODEBLOCK_${codeSpans.length - 1}@@`;
  });
  markdown = markdown.replace(/`[^`]*`/g, (m) => {
    codeSpans.push(m);
    return `@@CODESPAN_${codeSpans.length - 1}@@`;
  });

  // Remove inline tags (avoid headings; require whitespace or '(' before '#')
  // Keep the leading whitespace/paren so we don’t join words
  markdown = markdown.replace(/(^|[\s(])#([A-Za-z0-9/_-]+)\b/g, "$1");

  // Re-insert code blocks/spans
  markdown = markdown.replace(
    /@@(?:CODEBLOCK|CODESPAN)_(\d+)@@/g,
    (_m, idx) => {
      const i = Number(idx);
      return Number.isFinite(i) ? (codeSpans[i] ?? "") : "";
    },
  );

  // NOTE: Do NOT “tidy up” whitespace globally.
  // Collapsing spaces can change markdown meaning and create phantom diffs.

  return markdown;
}