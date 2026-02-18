# Obsidian Confluence Sync

Export a selected set of Obsidian notes to Confluence (Cloud or Server/DC), including links, attachments, callouts, and labels — with a review step before publishing.

## Status

⚠️ **Alpha (0.x)** — schemas and behaviours may change.  
Recommended for testing and internal use.

## Features

- Export current note + one of:
  - Backlinks
  - Outlinks
  - Graph crawl (BFS depth)
- Review export plan before publishing:
  - Shows Create / Update / Recreate / Skip
  - Deselect items or cancel export
- Converts Obsidian Markdown to Confluence Storage format (HTML/macros)
- Upload embedded images as attachments
- Obsidian tags → Confluence labels
- Callouts → Confluence styled callouts/panels (depending on config)

## Non-goals (for now)

- Two-way sync (Confluence → Obsidian)
- Full fidelity for every Obsidian plugin syntax
- Perfect WYSIWYG equivalence

## Install

### From GitHub Release (recommended)
1. Download the latest release assets:
   - `main.js`
   - `manifest.json`
   - `styles.css` (if present)
2. Create a folder:
   - `<vault>/.obsidian/plugins/obsidian-confluence-sync/`
3. Put the files in that folder.
4. In Obsidian:
   - Settings → Community plugins → enable **Obsidian Confluence Sync**

### Development install
1. Clone repo
2. `npm install`
3. `npm run build`
4. Copy output files into:
   - `<vault>/.obsidian/plugins/obsidian-confluence-sync/`

## Configuration

Open:
Settings → Community plugins → Obsidian Confluence Sync

### Required
- **Base URL**
  - Cloud: `https://your-site.atlassian.net` (plugin will use `/wiki/rest/api`)
  - Self-hosted: `https://confluence.company.com` (plugin will use `/rest/api`)
- **Space Key**
  - Found in the space sidebar / space settings (usually a short uppercase key)

### Auth
- **Cloud**: API token / PAT depending on your chosen auth mode
- **Self-hosted (Server/DC)**: depends on your instance configuration
  - Often PAT Bearer or Basic (username + token/password)

## Usage

### Review export (recommended)
- Command palette → **Export to Confluence (Review…)**
- Review the plan, deselect items if needed
- Click **Export selected**

### Export without review
- Command palette → **Confluence Sync: Export current + linked set**

## Known limitations

- Attachments may create new versions on repeated export (improvements planned)
- Task lists are currently exported as plain lists (native Confluence tasks planned)
- Some markdown extensions may not convert perfectly

## Roadmap

- Attachment “skip unchanged” (hashing)
- Native Confluence task list conversion
- Conflict detection when mapping points to a different page than title-search
- Dry run improvements + diff preview

## Contributing

PRs welcome. Please:
- keep changes scoped
- add test notes/examples where relevant
- avoid breaking the mapping schema without a migration

## License

Apache
