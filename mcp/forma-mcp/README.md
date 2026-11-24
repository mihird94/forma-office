# Forma MCP

Forma MCP connects a local assistant to the same index used by the Forma Start Hub and ⌘K search. The stdio server delegates each index operation to `forma-indexer`. Document extraction, Apple Vision OCR, and EmbeddingGemma 2 run on the Mac.

Run these commands from the Forma repository.

```sh
npm ci
npm run setup:embed
npm run build:mac
npm run mac:install-indexer
```

Forma reconciles the watched folders on login and daily at 02:00 local time. Between scans, macOS file-change events queue updates for affected files and subfolders. Forma checks modification time, file size, and the embedding model before extracting content. Backfills start with the newest files and rotate through the watched folders. The model starts when indexing needs it and shuts down after the worker idles.

Add or remove watched folders from **Indexed Folders** in the Start Hub or ⌘K. Adding a folder queues a catch-up pass. Removing a watched folder removes its indexed entries when no remaining root covers them. The index and configuration live in `~/Library/Application Support/FormaOffice`. Set `FORMA_INDEX_INTERVAL_SECONDS` at install time for additional reconciliation runs. `npm run mac:uninstall-indexer` stops both background jobs and preserves the index.

## Register the stdio server

Run the following commands from the repository root. Use an absolute Node executable path if your client launches with a restricted PATH.

**Claude Code**

```sh
claude mcp add --transport stdio forma -- node "$PWD/mcp/forma-mcp/index.mjs"
```

**Other MCP Clients (Cursor, Gemini CLI, etc.)**

Add the `forma` entry under `mcpServers` in your MCP client configuration file. Replace the example path with the absolute path to this checkout.

```json
{
  "mcpServers": {
    "forma": {
      "command": "node",
      "args": ["/absolute/path/to/forma-office/mcp/forma-mcp/index.mjs"]
    }
  }
}
```

## Tools

| Tool | Use |
| --- | --- |
| `forma_search` | Find ranked text and visual matches. Optionally filter by kind or limit. |
| `forma_read` | Read an indexed document by ID or a supported file inside a watched folder. Set `ocr` to include PDF OCR for pages without text. |
| `forma_index` | Sync watched folders or index a file or subfolder inside one. Set `force` to reindex unchanged files. |
| `forma_status` | View index counts, watched folders, the embedding model, and the last completed sync time. |
| `forma_folders` | List watched folders. Manage watched folders in Forma or through the local CLI. |
| `forma_open` | Open a file in a watched folder in its native Forma app. |
| `forma_create_canvas` | Create a `.fcanvas` or `.excalidraw` diagram inside a watched folder from a Mermaid flowchart (`mermaid`) or starter template (`blank`, `architecture`, `mindmap`, `kanban`). Optionally set `open: true` to launch in Forma Canvas. |
| `forma_create_sheet` | Create a `.xlsx` or `.csv` spreadsheet inside a watched folder from structured `sheets` (`name` + `rows`). Cell strings starting with `=` are written as Excel formulas with styled headers and auto-sized columns. Optionally set `open: true` to launch in Forma Sheets. |
| `forma_create_slides` | Create a 16:9 `.pptx` presentation inside a watched folder from structured `slides` (`title`, `subtitle`, `bullets`, `notes`) with `light`, `dark`, or `ocean` theme. Optionally set `open: true` to launch in Forma Slides. |
| `forma_create_doc` | Create a `.docx` or `.md` document inside a watched folder from Markdown (`headings`, bullet/numbered lists, fenced code blocks, and pipe tables). Optionally set `open: true` to launch in Forma Docs. |

All `forma_create_*` tools enforce the same watched-folder boundary as `forma_read` and `forma_open` (existing non-hidden parent directory inside a watched folder, non-hidden filename, and no symlink overwrites) and automatically trigger a best-effort index update so newly created files are immediately searchable.

For a trusted local MCP client that manages folder access, set `FORMA_MCP_ALLOW_FOLDER_CHANGES=1` in its server environment to enable `add` and `remove`.

The first full sync may take longer than a client’s default tool timeout. Start it from **Sync Now** in Forma or run `"$HOME/Library/Application Support/FormaOffice/bin/forma-indexer" sync --json`.

## Verify the installation

```sh
npx tsc -b
npm test -- --run
node scripts/verify-indexer.mjs
node scripts/verify-index-watcher.mjs
```

The verification scripts use temporary fixtures and the embedded runtime with Ollama disabled. They cover Office, PDF, notebook and Canvas indexing, MCP over stdio, fair backfill order, and file and folder changes while the watcher is running or offline.
