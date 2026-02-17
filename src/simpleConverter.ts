import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import footnote from "markdown-it-footnote";

export class SimpleConfluenceConverter {
  private md: MarkdownIt;

  constructor() {
    this.md = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: false
    })
      .use(taskLists, { enabled: true })
      .use(footnote);
  }

  convert(markdown: string): string {
    // Confluence storage supports most standard tags produced by markdown-it (p, h1-6, ul/ol/li, strong/em, code/pre, table)
    // It does NOT love raw HTML; we have html=false above.
    return this.md.render(markdown);
  }
}
