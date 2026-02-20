// src/storageNormalise.ts

/**
 * Confluence storage format is HTML-ish and gets "normalised" by Confluence.
 * This function aggressively normalizes both sides so "semantically identical"
 * content compares equal.
 *
 * This is not perfect HTML parsing, but it’s safe and works well for storage diffs.
 */
export function normaliseStorage(storage: string): string {
  if (!storage) return "";

  let s = storage;

  // Line endings + trim
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // Collapse whitespace
  s = s.replace(/[ \t]+/g, " "); // collapse runs of spaces
  s = s.replace(/\n{2,}/g, "\n"); // collapse blank lines
  s = s.replace(/>\s+</g, "><"); // remove whitespace between tags

  // Normalize self-closing variants
  s = s.replace(/<br\s*>/gi, "<br/>");
  s = s.replace(/<br\s*\/\s*>/gi, "<br/>");
  s = s.replace(/<hr\s*>/gi, "<hr/>");
  s = s.replace(/<hr\s*\/\s*>/gi, "<hr/>");

  // Normalize common smart punctuation entities vs unicode chars
  s = s.replace(/&rsquo;|&#8217;|&#x2019;/gi, "’");
  s = s.replace(/&lsquo;|&#8216;|&#x2018;/gi, "‘");
  s = s.replace(/&ldquo;|&#8220;|&#x201C;/gi, "“");
  s = s.replace(/&rdquo;|&#8221;|&#x201D;/gi, "”");
  s = s.replace(/&ndash;|&#8211;|&#x2013;/gi, "–");
  s = s.replace(/&mdash;|&#8212;|&#x2014;/gi, "—");

  // Normalize bullet entity vs bullet char (your screenshot shows &bull;)
  s = s.replace(/&bull;|&#8226;|&#x2022;/gi, "•");

  // Normalize nbsp
  s = s.replace(/&nbsp;|&#160;|&#xA0;/gi, " ");

  // Confluence sometimes injects volatile attributes.
  // Keep conservative: only strip things that should never matter.
  s = stripAttributeEverywhere(s, "data-mce-style");
  s = stripAttributeEverywhere(s, "data-mce-bogus");
  s = stripAttributeEverywhere(s, "data-mce-selected");
  s = stripAttributeEverywhere(s, "data-mce-href");
  s = stripAttributeEverywhere(s, "contenteditable");
  s = stripAttributeEverywhere(s, "spellcheck");

  // Volatile Confluence attrs we never want diffs for
  s = stripAttributeEverywhere(s, "ri:version-at-save");
  s = stripAttributeEverywhere(s, "ac:macro-id");
  s = stripAttributeEverywhere(s, "ac:local-id");

  // ⚠️ schema-version can vary between instances; safe to drop for diff purposes
  s = stripAttributeEverywhere(s, "ac:schema-version");

  // Normalize empty paragraphs / editor noise
  s = s.replace(/<p><br\/><\/p>/gi, "");
  s = s.replace(/<p>\s*<\/p>/gi, "");

  // Confluence often wraps list item bodies in <p>...</p> (or removes them).
  // Normalise these wrappers so <li><p>Text</p></li> compares equal to <li>Text</li>
  s = s.replace(/<li>\s*<p>/gi, "<li>");
  s = s.replace(/<\/p>\s*<\/li>/gi, "</li>");

  // Normalize CDATA wrappers in link bodies (Confluence flips between CDATA/plain)
  s = normalisePlainTextLinkBodies(s);

  // Sort macro params and common tag attributes (ordering differences are noise)
  s = normaliseMacroParameterOrder(s);
  s = sortAttributesForKnownTags(s);

  // Final trim + re-collapse inter-tag whitespace after transformations
  s = s.replace(/>\s+</g, "><").trim();

  return s;
}

/**
 * Confluence often represents link body text as:
 * <ac:plain-text-link-body><![CDATA[Text]]></ac:plain-text-link-body>
 * or without CDATA. Normalize to a consistent non-CDATA form.
 */
function normalisePlainTextLinkBodies(html: string): string {
  return html.replace(
    /<ac:plain-text-link-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-link-body>/gi,
    (_m, inner) => {
      const text = String(inner ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return `<ac:plain-text-link-body>${escapeXmlText(text)}</ac:plain-text-link-body>`;
    },
  );
}

/**
 * Escape only the minimum needed for text nodes we inject.
 * (We don't want to double-escape existing markup.)
 */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normaliseMacroParameterOrder(html: string): string {
  // Sort parameters inside each structured-macro block.
  return html.replace(
    /<ac:structured-macro\b[^>]*>[\s\S]*?<\/ac:structured-macro>/gi,
    (macro) => sortParamsInMacro(macro),
  );
}

function sortParamsInMacro(macro: string): string {
  const paramRe =
    /<ac:parameter\b[^>]*ac:name="([^"]+)"[^>]*>[\s\S]*?<\/ac:parameter>/gi;

  const params: Array<{ name: string; xml: string }> = [];
  let m: RegExpExecArray | null;

  while ((m = paramRe.exec(macro)) !== null) {
    params.push({ name: m[1].toLowerCase(), xml: m[0] });
  }

  if (params.length <= 1) return macro;

  // Remove params from macro
  const macroNoParams = macro.replace(paramRe, "");

  // Sort by name
  params.sort((a, b) => a.name.localeCompare(b.name));

  // Re-insert params right after opening tag
  const openTagMatch = macroNoParams.match(/^<ac:structured-macro\b[^>]*>/i);
  if (!openTagMatch) return macro;

  const openTag = openTagMatch[0];
  const rest = macroNoParams.slice(openTag.length);

  return `${openTag}${params.map((p) => p.xml).join("")}${rest}`;
}

/**
 * Confluence can reorder attributes which causes false diffs.
 * We sort attributes for a few common tags we know Confluence emits a lot.
 */
function sortAttributesForKnownTags(html: string): string {
  const tagNames = [
    "ac:structured-macro",
    "ac:parameter",
    "ac:link",
    "ac:image",
    "ri:page",
    "ri:attachment",
    "ri:url",
  ];

  const re = new RegExp(
    `<(${tagNames.map(escapeRegExp).join("|")})\\b([^>]*?)>`,
    "gi",
  );

  return html.replace(re, (_m, tagName, attrChunk) => {
    const attrs = parseAttributes(attrChunk);
    if (attrs.length === 0) return `<${tagName}>`;

    // Sort by attribute name (case-insensitive)
    attrs.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );

    const rebuilt = attrs.map((a) => a.raw).join(" ");
    return `<${tagName} ${rebuilt}>`;
  });
}

function parseAttributes(chunk: string): Array<{ name: string; raw: string }> {
  const out: Array<{ name: string; raw: string }> = [];

  // Matches:  name="..." | name='...' | name=bare
  const re = /([A-Za-z_:][A-Za-z0-9:._-]*)=(?:"[^"]*"|'[^']*'|[^\s>]+)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(chunk)) !== null) {
    const name = m[1];
    const raw = m[0];
    out.push({ name, raw });
  }

  return out;
}

function stripAttributeEverywhere(html: string, attrName: string): string {
  // removes: attr="..." OR attr='...' OR attr=bare
  const re = new RegExp(
    `\\s${escapeRegExp(attrName)}=(?:"[^"]*"|'[^']*'|[^\\s>]+)`,
    "gi",
  );
  return html.replace(re, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}