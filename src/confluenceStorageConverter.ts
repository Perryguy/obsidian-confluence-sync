import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import footnote from "markdown-it-footnote";
type MdToken = ReturnType<MarkdownIt["parse"]>[number];

export type ResolveWikiLinkFn = (
  target: string,
  fromPath: string,
) => { title: string } | null;

export interface ConvertContext {
  spaceKey: string;
  fromPath: string;
  resolveWikiLink: ResolveWikiLinkFn;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function codeMacro(code: string, language?: string): string {
  const lang = (language?.trim() || "text").toLowerCase();
  return (
    `<ac:structured-macro ac:name="code">` +
    `<ac:parameter ac:name="language">${escapeXml(lang)}</ac:parameter>` +
    `<ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body>` +
    `</ac:structured-macro>`
  );
}

function panelColorsFor(type: string) {
  switch (type) {
    case "warning":
    case "caution":
      return {
        borderColor: "#FFAB00",
        bgColor: "#FFFAE6",
        titleBGColor: "#FFAB00",
        titleColor: "#172B4D",
      };
    case "danger":
    case "error":
    case "fail":
      return {
        borderColor: "#DE350B",
        bgColor: "#FFEBE6",
        titleBGColor: "#DE350B",
        titleColor: "#FFFFFF",
      };
    case "success":
    case "done":
    case "check":
      return {
        borderColor: "#36B37E",
        bgColor: "#E3FCEF",
        titleBGColor: "#36B37E",
        titleColor: "#FFFFFF",
      };
    case "tip":
    case "hint":
      return {
        borderColor: "#00B8D9",
        bgColor: "#E6FCFF",
        titleBGColor: "#00B8D9",
        titleColor: "#172B4D",
      };
    case "note":
    case "info":
    default:
      return {
        borderColor: "#4C9AFF",
        bgColor: "#DEEBFF",
        titleBGColor: "#4C9AFF",
        titleColor: "#FFFFFF",
      };
  }
}

function panelMacro(title: string, bodyStorage: string, type: string): string {
  const c = panelColorsFor(type);

  return (
    `<ac:structured-macro ac:name="panel">` +
    `<ac:parameter ac:name="title">${escapeXml(title)}</ac:parameter>` +
    `<ac:parameter ac:name="borderStyle">solid</ac:parameter>` +
    `<ac:parameter ac:name="borderWidth">1</ac:parameter>` +
    `<ac:parameter ac:name="borderColor">${c.borderColor}</ac:parameter>` +
    `<ac:parameter ac:name="bgColor">${c.bgColor}</ac:parameter>` +
    `<ac:parameter ac:name="titleBGColor">${c.titleBGColor}</ac:parameter>` +
    `<ac:parameter ac:name="titleColor">${c.titleColor}</ac:parameter>` +
    `<ac:rich-text-body>${bodyStorage}</ac:rich-text-body>` +
    `</ac:structured-macro>`
  );
}

function panelStyleFor(type: string): string {
  // Confluence panelStyle supports CSS-like style string
  // Keep it conservative so Cloud accepts it.
  switch (type) {
    case "warning":
    case "caution":
      return "border-color: #FFAB00; background-color: #FFFAE6;";
    case "danger":
    case "error":
    case "fail":
      return "border-color: #DE350B; background-color: #FFEBE6;";
    case "success":
    case "done":
    case "check":
      return "border-color: #36B37E; background-color: #E3FCEF;";
    case "tip":
    case "hint":
      return "border-color: #00B8D9; background-color: #E6FCFF;";
    case "note":
    case "info":
    default:
      return "border-color: #4C9AFF; background-color: #DEEBFF;";
  }
}

function confluencePageLink(
  spaceKey: string,
  pageTitle: string,
  bodyText: string,
): string {
  // Using title+space is the most compatible form across Cloud + DC
  return (
    `<ac:link>` +
    `<ri:page ri:space-key="${escapeXml(spaceKey)}" ri:content-title="${escapeXml(pageTitle)}" />` +
    `<ac:plain-text-link-body><![CDATA[${bodyText}]]></ac:plain-text-link-body>` +
    `</ac:link>`
  );
}

type WikiLinkMeta = { target: string; alias?: string };
type EmbedMeta = { target: string; alias?: string };

function normalizeWikiTarget(raw: string): string {
  return raw.split("#")[0].trim();
}

/**
 * Parse Obsidian wikilinks:
 *  - [[Note]]
 *  - [[Note|Alias]]
 *  - [[...]] and ![[...]]
 */
function obsidianLinksPlugin(md: MarkdownIt) {
  md.inline.ruler.before(
    "link",
    "obsidian_wikilink_or_embed",
    (state, silent) => {
      const pos = state.pos;
      const src = state.src;

      // Bounds check
      if (pos >= src.length) return false;

      const startsWith = (s: string) => src.startsWith(s, pos);

      const isEmbed = startsWith("![[");
      const isLink = startsWith("[[");

      if (!isEmbed && !isLink) return false;

      const start = pos + (isEmbed ? 3 : 2);
      const end = src.indexOf("]]", start);
      if (end === -1) return false;

      const inner = src.slice(start, end).trim();
      if (!inner) return false;

      // IMPORTANT: always advance pos if we claim a match
      const nextPos = end + 2;

      if (silent) {
        state.pos = nextPos;
        return true;
      }

      const [rawTarget, rawAlias] = inner.split("|");
      const target = normalizeWikiTarget((rawTarget ?? "").trim());
      const alias = rawAlias?.trim();

      const tokenType = isEmbed ? "obsidian_embed" : "obsidian_wikilink";
      const token = state.push(tokenType, "", 0);
      token.meta = { target, alias };

      state.pos = nextPos;
      return true;
    },
  );
}

export class ConfluenceStorageConverter {
  private md: MarkdownIt;

  constructor() {
    this.md = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: false,
    })
      .use(taskLists, { enabled: true })
      .use(footnote)
      .use(obsidianLinksPlugin);
  }

  convert(markdown: string, ctx: ConvertContext): string {
    const tokens = this.md.parse(markdown, {});
    return this.renderBlock(tokens, ctx);
  }

  private renderBlock(tokens: MdToken[], ctx: ConvertContext): string {
    let out = "";
    let i = 0;

    while (i < tokens.length) {
      const t = tokens[i];

      switch (t.type) {
        case "paragraph_open":
          out += "<p>";
          i++;
          break;
        case "paragraph_close":
          out += "</p>";
          i++;
          break;

        case "heading_open":
          out += `<${t.tag}>`;
          i++;
          break;
        case "heading_close":
          out += `</${t.tag}>`;
          i++;
          break;

        case "inline":
          out += this.renderInline(t.children ?? [], ctx);
          i++;
          break;

        case "bullet_list_open":
          out += "<ul>";
          i++;
          break;
        case "bullet_list_close":
          out += "</ul>";
          i++;
          break;

        case "ordered_list_open":
          out += "<ol>";
          i++;
          break;
        case "ordered_list_close":
          out += "</ol>";
          i++;
          break;

        case "list_item_open":
          out += "<li>";
          i++;
          break;
        case "list_item_close":
          out += "</li>";
          i++;
          break;

        case "blockquote_open": {
          // Callout detection: > [!info] Title
          const callout = this.tryParseCallout(tokens, i, ctx);
          if (callout) {
            out += callout.rendered;
            i = callout.nextIndex;
          } else {
            out += "<blockquote>";
            i++;
          }
          break;
        }
        case "blockquote_close":
          out += "</blockquote>";
          i++;
          break;

        case "fence": {
          const lang = (t.info || "").split(/\s+/)[0];
          out += codeMacro(t.content ?? "", lang);
          i++;
          break;
        }

        case "hr":
          out += "<hr />";
          i++;
          break;

        // Tables (markdown-it built-in)
        case "table_open":
          out += "<table>";
          i++;
          break;
        case "table_close":
          out += "</table>";
          i++;
          break;
        case "thead_open":
          out += "<thead>";
          i++;
          break;
        case "thead_close":
          out += "</thead>";
          i++;
          break;
        case "tbody_open":
          out += "<tbody>";
          i++;
          break;
        case "tbody_close":
          out += "</tbody>";
          i++;
          break;
        case "tr_open":
          out += "<tr>";
          i++;
          break;
        case "tr_close":
          out += "</tr>";
          i++;
          break;
        case "th_open":
          out += "<th>";
          i++;
          break;
        case "th_close":
          out += "</th>";
          i++;
          break;
        case "td_open":
          out += "<td>";
          i++;
          break;
        case "td_close":
          out += "</td>";
          i++;
          break;

        default:
          // ignore unsupported token types safely
          if (t.content) out += `<p>${escapeXml(t.content)}</p>`;
          i++;
          break;
      }
    }

    return out;
  }

  private renderInline(tokens: MdToken[], ctx: ConvertContext): string {
    let out = "";
    let i = 0;

    while (i < tokens.length) {
      const t = tokens[i];

      switch (t.type) {
        case "text":
          out += escapeXml(t.content ?? "");
          i++;
          break;

        case "softbreak":
          out += "\n";
          i++;
          break;

        case "hardbreak":
          out += "<br />";
          i++;
          break;

        case "code_inline":
          out += `<code>${escapeXml(t.content ?? "")}</code>`;
          i++;
          break;

        case "em_open":
          out += "<em>";
          i++;
          break;
        case "em_close":
          out += "</em>";
          i++;
          break;

        case "strong_open":
          out += "<strong>";
          i++;
          break;
        case "strong_close":
          out += "</strong>";
          i++;
          break;

        case "link_open": {
          const href = t.attrGet("href") ?? "";
          const closeIdx = this.findClose(tokens, i, "link_close");
          const bodyTokens = closeIdx > i ? tokens.slice(i + 1, closeIdx) : [];
          const bodyText = this.inlinePlainText(bodyTokens);
          out += `<a href="${escapeXml(href)}">${escapeXml(bodyText)}</a>`;
          i = closeIdx + 1;
          break;
        }

        case "obsidian_embed": {
          const meta = (t.meta ?? {}) as any;
          const target = normalizeWikiTarget(meta.target);
          const alias = meta.alias?.trim() || target;

          // We render embeds as attachments (filename) — exporter will upload them
          const resolved = ctx.resolveWikiLink(target, ctx.fromPath);
          if (resolved) {
            // resolved.title here is a NOTE title (for links). For embeds, we want the filename.
            // We'll pass filename via resolver when it's an attachment (see exporter ctx below).
            const filename = resolved.title;
            out += `<ac:image><ri:attachment ri:filename="${escapeXml(filename)}" /></ac:image>`;
          } else {
            out += escapeXml(alias);
          }
          i++;
          break;
        }

        case "obsidian_wikilink": {
          const meta = (t.meta ?? {}) as WikiLinkMeta;
          const target = normalizeWikiTarget(meta.target);
          const alias = meta.alias?.trim() || target;

          const resolved = ctx.resolveWikiLink(target, ctx.fromPath);
          if (resolved) {
            out += confluencePageLink(ctx.spaceKey, resolved.title, alias);
          } else {
            out += escapeXml(alias);
          }
          i++;
          break;
        }

        // task list checkboxes from markdown-it-task-lists often appear as html_inline
        case "html_inline": {
          const html = t.content ?? "";
          if (html.includes("task-list-item-checkbox")) {
            const checked = /\bchecked\b/i.test(html);
            out += checked ? "☑ " : "☐ ";
          } else {
            out += escapeXml(html);
          }
          i++;
          break;
        }

        default:
          if (t.content) out += escapeXml(t.content);
          i++;
          break;
      }
    }

    return out;
  }

  private inlinePlainText(tokens: MdToken[]): string {
    let s = "";
    for (const t of tokens) {
      if (t.type === "text" || t.type === "code_inline") s += t.content ?? "";
      else if (t.type === "softbreak" || t.type === "hardbreak") s += " ";
      else if (t.children?.length) s += this.inlinePlainText(t.children);
    }
    return s.trim();
  }

  private findClose(
    tokens: MdToken[],
    openIdx: number,
    closeType: string,
  ): number {
    for (let i = openIdx + 1; i < tokens.length; i++) {
      if (tokens[i].type === closeType) return i;
    }
    return openIdx;
  }

  private tryParseCallout(
    tokens: any[],
    blockquoteOpenIndex: number,
    ctx: ConvertContext,
  ): { rendered: string; nextIndex: number } | null {
    // Expect:
    // blockquote_open
    // paragraph_open
    // inline (header + maybe body in same paragraph)
    // paragraph_close
    if (tokens[blockquoteOpenIndex]?.type !== "blockquote_open") return null;
    if (tokens[blockquoteOpenIndex + 1]?.type !== "paragraph_open") return null;

    const inlineTok = tokens[blockquoteOpenIndex + 2];
    if (!inlineTok || inlineTok.type !== "inline") return null;

    const children: any[] = inlineTok.children ?? [];
    if (children.length === 0) return null;

    // Split inline children at the first line break (softbreak/hardbreak)
    const brIndex = children.findIndex(
      (t) => t.type === "softbreak" || t.type === "hardbreak",
    );
    const headerChildren =
      brIndex === -1 ? children : children.slice(0, brIndex);
    const restChildren = brIndex === -1 ? [] : children.slice(brIndex + 1);

    const headerText = this.inlinePlainText(headerChildren).trim();
    const m = headerText.match(/^\s*\[!([a-zA-Z]+)\]\s*(.*)\s*$/);
    if (!m) return null;

    const calloutType = (m[1] ?? "info").toLowerCase();
    const title = (m[2]?.trim() || calloutType.toUpperCase()).trim();

    // Find matching blockquote_close
    let depth = 0;
    let j = blockquoteOpenIndex;
    for (; j < tokens.length; j++) {
      if (tokens[j].type === "blockquote_open") depth++;
      if (tokens[j].type === "blockquote_close") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= tokens.length) return null;

    // Build body tokens:
    //  - If there was remaining content in the first paragraph, keep it as a paragraph.
    //  - Then include the rest of the blockquote tokens after the first paragraph_close.
    const body: any[] = [];

    if (restChildren.length > 0) {
      // Recreate the paragraph with remaining inline children
      body.push({ type: "paragraph_open", tag: "p" });
      body.push({ type: "inline", children: restChildren });
      body.push({ type: "paragraph_close", tag: "p" });
    }

    // After paragraph_close comes the rest of the blockquote content
    // header structure indexes: open, p_open, inline, p_close
    const afterFirstParagraph = blockquoteOpenIndex + 4;
    for (let k = afterFirstParagraph; k < j; k++) body.push(tokens[k]);

    const bodyStorage = this.renderBlock(body, ctx);
    return {
      rendered: panelMacro(title, bodyStorage, calloutType),
      nextIndex: j + 1,
    };
  }
}
