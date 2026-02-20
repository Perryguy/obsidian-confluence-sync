export function stripInlineTagsFromMarkdown(markdown: string): string {
  if (!markdown) return "";

  // Remove frontmatter block entirely (optional, but often desired)
  // If you DO want frontmatter content in Confluence, delete this block.
  markdown = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");

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

  // Tidy up double spaces created by removals
  markdown = markdown.replace(/[ \t]{2,}/g, " ");

  return markdown;
}