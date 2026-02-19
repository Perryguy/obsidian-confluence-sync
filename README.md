# Obsidian Confluence Sync

Publish Obsidian notes to Confluence Cloud or Server/Data Center with review, attachment sync, and tag-to-label support.

## Status

⚠️ **Alpha (0.x)** — schemas and behaviours may change.  
Recommended for testing and internal use.

## Features

- Export current note + backlinks / outlinks / graph depth
- Review export plan before publishing
- Detect Create / Update / Recreate / Skip
- Select/deselect items before export
- Obsidian tags → Confluence labels
- Upload embedded images as attachments
- Automatic REST root detection (Cloud + Self-hosted)
- Safe rename handling (mapping migration)
- Two-pass export for correct link resolution

## How It Works?

- Pass 1: Create/update pages
- Pass 2: Rewrite links

Mapping stored in plugin data

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
1. Open note
2. Command palette → **Export to Confluence (Review…)**
3. Select space
4. (Optional) Choose parent page
5. Review create/update/recreate
6. Export selected

### Export without review
- Command palette → **Confluence Sync: Export current + linked set**

## Mapping System
Mapping is stored in plugin data.
It is not visible in your vault.
It automatically updates on note rename.

## Known limitations

- Attachments may create new versions on repeated export (improvements planned)
- Task lists are currently exported as plain lists (native Confluence tasks planned)
- Some markdown extensions may not convert perfectly
- No comment syncing
- No attachment deletion detection
- No page move detection yet
- Title collision detection still limited

## Roadmap

- Attachment “skip unchanged” (hashing)
- Native Confluence task list conversion
- Dry run improvements + diff preview
- Parent conflict detection
- Page move detection
- Better diff awareness
- Incremental attachment sync

## Contributing

PRs welcome. Please:
- keep changes scoped
- add test notes/examples where relevant
- avoid breaking the mapping schema without a migration

## License

Apache
