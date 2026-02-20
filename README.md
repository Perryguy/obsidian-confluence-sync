# Obsidian Confluence Sync

Publish Obsidian notes to Confluence (Cloud or Server/Data Center) with
review, snapshot-based diffing, attachment sync, tag-to-label support,
and optional hierarchy generation.

------------------------------------------------------------------------

## Status

⚠️ **Alpha (0.x)** --- schemas and behaviours may change.\
Recommended for testing and internal use.

------------------------------------------------------------------------

## Features

### Core Export

-   Export current note + backlinks / outlinks / graph depth (BFS)
-   Two-pass export for correct link resolution
-   Detect **Create / Update / Recreate / Skip**
-   Optional dry run mode
-   Safe rename handling (mapping migration)

### Review Mode

-   Preview export plan before publishing
-   Select / deselect items
-   Snapshot-based diff awareness
-   Recreate detection (remote page deleted)
-   Conflict detection (limited, improving)

### Hierarchy (Optional)

-   Flat (all under parent/root)
-   Link-based hierarchy
-   Folder-based hierarchy
-   Frontmatter parent support
-   Hybrid strategies
-   Many-to-many conflict handling
-   Hierarchy preview before export

### Content Handling

-   Obsidian tags → Confluence labels
-   YAML frontmatter removed from published body
-   Inline `#tags` stripped from body (still applied as labels)
-   Embedded images uploaded as attachments
-   Wiki-links converted to Confluence page links
-   Two-pass link rewrite (ensures page IDs exist before final render)

### Compatibility

-   Automatic REST root detection
    -   Cloud: `/wiki/rest/api`
    -   Server/DC: `/rest/api`
-   Basic + Bearer authentication modes

------------------------------------------------------------------------

## How It Works

### 1️⃣ Export Set Resolution

Depending on export mode:

-   Backlinks
-   Outlinks
-   Graph crawl (BFS depth)

The plugin builds a deterministic export set.

------------------------------------------------------------------------

### 2️⃣ Hierarchy Resolution (Optional)

If hierarchy mode is enabled, the plugin determines parent-child
relationships **within the export set**.

#### Flat

Everything (except root) is created under: - The configured parent page,
or - The exported root page

#### Links

If Note A links to Note B and both are exported: - B may become a child
of A (depending on strategy)

#### Folder

Uses folder structure: - `folder/index.md` or `folder/folder.md` can
become parent

#### Frontmatter

``` yaml
parent: Some Note
```

#### Hybrid

Combines folder + link strategies.

#### Many-to-many Handling

If multiple possible parents exist:

Policies: - `firstSeen` - `closestToRoot` - `preferFolderIndex`

Cycles are automatically broken safely.

Hierarchy is previewed in the review modal before export.

------------------------------------------------------------------------

### 3️⃣ Two-Pass Export

#### Pass 1: Create / Ensure Pages

-   Create or update pages
-   Apply parent relationships
-   Write mapping
-   Upload attachments
-   Apply labels
-   Write content snapshots

#### Pass 2: Rewrite Content

-   Re-render markdown with final link resolution
-   Compare against last exported storage snapshot
-   Update only if content or title changed
-   Refresh snapshots

This prevents: - Broken links - Canonicalisation noise diffs - Partial
state exports

------------------------------------------------------------------------

## Mapping System

Mapping is stored in plugin data (not in your vault).

Each note maps to: - Confluence page ID - Title - Web UI link - Last
updated timestamp

On note rename: - Mapping key is migrated automatically - Page ID is
preserved

If a mapped page is deleted in Confluence: - Next export detects 404 -
Page is recreated - Mapping updated

------------------------------------------------------------------------

## Snapshot System

Two snapshot types are stored:

-   Published markdown snapshot
-   Normalised Confluence storage snapshot

Snapshots are used to: - Avoid unnecessary updates - Prevent Confluence
canonicalisation noise - Provide accurate diff detection

Snapshots represent what was actually published, not raw vault content.

------------------------------------------------------------------------

## Install

### From GitHub Release (recommended)

1.  Download:

    -   `main.js`
    -   `manifest.json`
    -   `styles.css` (if present)

2.  Create:

        <vault>/.obsidian/plugins/obsidian-confluence-sync/

3.  Place files in that folder.

4.  Enable in:

        Settings → Community Plugins

------------------------------------------------------------------------

### Development Install

1.  Clone repo

2.  `npm install`

3.  `npm run build`

4.  Copy output into:

        <vault>/.obsidian/plugins/obsidian-confluence-sync/

------------------------------------------------------------------------

## Configuration

Open:

Settings → Community Plugins → Obsidian Confluence Sync

### Required

#### Base URL

-   Cloud: `https://your-site.atlassian.net`
-   Self-hosted: `https://confluence.company.com`

The plugin auto-detects REST root.

#### Space Key

Found in: - Space sidebar - Space settings - URL (`/spaces/ENG/...`)

------------------------------------------------------------------------

### Authentication

#### Cloud

-   API token (Basic)
-   PAT (Bearer)

#### Server / Data Center

-   Depends on instance configuration
-   Usually PAT or Basic

------------------------------------------------------------------------

## Usage

### Review Export (Recommended)

1.  Open a note
2.  Command Palette → **Export to Confluence (Review...)**
3.  Select space
4.  (Optional) Choose parent page
5.  Choose hierarchy mode
6.  Review changes
7.  Export selected

------------------------------------------------------------------------

### Quick Export (No Review)

Command Palette →\
**Confluence Sync: Export current + linked set**

------------------------------------------------------------------------

## Known Limitations

-   Attachments may create new versions on repeated export
-   No Confluence → Obsidian sync
-   No comment syncing
-   No automatic page move detection (yet)
-   Attachment deletion not detected
-   Title collision detection limited
-   Hierarchy is not complete. Best to use the frontmatter setting for now.
-   Labels are not deleted when tags are removed from Obsidian document.
-   Sized embed images currently not supported.

------------------------------------------------------------------------

## Roadmap

-   Attachment hash-based skip
-   Page move detection
-   Parent conflict detection
-   Incremental attachment sync
-   Content property storage support
-   Advanced hierarchy conflict resolution

------------------------------------------------------------------------

## Non-Goals (for now)

-   Two-way sync
-   Full WYSIWYG parity
-   Perfect support for every Obsidian plugin syntax

------------------------------------------------------------------------

## Contributing

PRs welcome.

Please: - Keep changes scoped - Add test notes/examples - Avoid breaking
the mapping schema without migration

------------------------------------------------------------------------

## License

Apache 2.0
