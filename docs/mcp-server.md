# MCP server — working on theses with an agent

`backend/mcp_server.py` exposes the THESES workspace (PORT → TOOLS → THESES) plus the
terminal's portfolio and market data to an MCP client — Claude Code, Claude Desktop, or
anything else that speaks MCP over stdio.

It is an **HTTP client of the running backend**, not a second writer on `portfolio.db`:
every write goes through the same validation, event log and Google-Drive sync as the UI.
So the backend must be running (`:9317`) whenever the agent is using it.

## Requirements

```bash
pip install -r backend/requirements.txt    # brings in mcp>=2.2,<3
```

## Claude Code

Nothing to install — `.mcp.json` at the repo root is picked up when a session starts in
this folder; approve the `bloomberg-terminal` server once when prompted. To use it from
any folder instead:

```bash
claude mcp add bloomberg-terminal --scope user -- python D:/Agents/Claude/bloomberg-terminal-main/backend/mcp_server.py
```

## Claude Desktop

Desktop does **not** read the repo's `.mcp.json`. Add the server to
`%APPDATA%\Claude\claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`) and restart the app —
quitting from the tray, not just closing the window.

```jsonc
{
  "mcpServers": {
    "bloomberg-terminal": {
      // absolute interpreter path: Desktop does not inherit your shell PATH
      "command": "C:\\Users\\<you>\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
      "args": ["D:\\Agents\\Claude\\bloomberg-terminal-main\\backend\\mcp_server.py"],
      "env": {
        "PYTHON_API_URL": "http://localhost:9317",
        "MCP_AGENT_NAME": "desktop",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1"
      }
    }
  }
}
```

`MCP_AGENT_NAME` is what shows up in the thesis timeline, so give each client its own
name (`claude` for Claude Code, `desktop` here) — that is how you tell later which agent
wrote what. `PYTHONIOENCODING=utf-8` matters on Windows: the tool messages contain `→`
and `–`, and the default cp1252 console encoding raises on them.

## Any other MCP client

The server is a standard stdio MCP server, so anything that speaks MCP takes the same
three fields — command, args, env — under whatever key that client uses
(`mcpServers`, `mcp.servers`, `context_servers`, …):

```json
{
  "command": "python",
  "args": ["D:/Agents/Claude/bloomberg-terminal-main/backend/mcp_server.py"],
  "env": { "PYTHON_API_URL": "http://localhost:9317", "MCP_AGENT_NAME": "cursor" }
}
```

Give each client its own `MCP_AGENT_NAME`: it becomes the `AGENT·<NAME>` tag in the thesis
timeline and the `actor` on every zettel, which is the only way to tell later which agent
wrote what.

**Clients that cannot spawn a process** (n8n, a hosted agent, anything on another machine)
use the HTTP transport instead — same tools, same code:

```bash
MCP_TRANSPORT=streamable-http MCP_PORT=9319 python backend/mcp_server.py
```

It serves `http://127.0.0.1:9319/mcp`. It binds to loopback on purpose: the server writes to
the portfolio and carries no auth of its own, so reaching it from another host should be a
deliberate act (an SSH tunnel), never a default. `MCP_HOST` can override that — don't, unless
you have put something in front of it.

**Agents with no MCP support at all** can use the REST API directly: `/api/v2/theses/*` and
`/api/v2/zettel/*` on the backend, with the `X-Thesis-Actor: agent:<name>` header so the
attribution still works. `memory/reference/api-endpoints.md` lists every route.

## Tools

| Group | Tools |
|---|---|
| Theses (read) | `list_theses` · `get_thesis` · `notes_due` |
| Theses (write) | `create_thesis` (always `draft`) · `update_thesis` (`reason` required) · `log_event` (NOTE/REVIEW/EVIDENCE/CHECKPOINT) · `add_note` · `update_note` · `link_trade` |
| Portfolio | `get_positions` · `get_trades` |
| Research | `get_stock_data(kind=quote\|financials\|ratios\|estimates\|analyst\|earnings-calendar\|ownership\|management\|dividends\|pe-history\|quality\|sector\|sec-filings)` · `get_price_history` · `get_news` · `get_filings` |
| Analysis graphs | `graph_list` · `graph_get` · `graph_create` · `graph_update` |
| Knowledge base | `zettel_search` · `zettel_list` · `zettel_get` · `zettel_create` · `zettel_update` · `zettel_link` · `zettel_add_source` · `zettel_attach` · `open_conflicts` · `resolve_conflict` · `zettel_by_source` |

### Analysis graphs

Some findings only read as a picture. `graph_create` saves one page into
`research/graphs/<slug>/index.html` and indexes it in the `graphs` table. Attach it with
`thesis_id` (writes a `GRAPH_ADDED` event) and `zettel_refs` so the picture points back at
the notes it argues from; `as_of` is the date of the DATA.

**Send the content, not a document.** `backend/graph_shell.py` wraps the stored HTML at
render time with the masthead, the academic typography, the Thai face (Laksaman, embedded
as a data: URI) and a sticky tab strip built from the page's own `<h2>`/`<h3>` — so every
analysis page reads alike and an old page picks up a format change without being rewritten.
Start from `research/graphs/_template.html`, which documents the classes the shell styles
(`.lede`, `.note`, `.fig`, `.tablebox`, `.src`). Two rules are enforced on write: **no
external requests** (the render CSP blocks them, so an off-box `<img>`/stylesheet is a hole
in the page — 400) and at least one `<h2>` (otherwise there is no contents rail — returned in
`warnings`). `?shell=0` on the render URL shows the raw file.

The page is model-written, so it is never rendered on the app's own origin: the backend
serves it under a strict CSP and the UI frames it with `sandbox="allow-scripts"` and no
`allow-same-origin`. `graph_update` bumps the version and keeps the old page beside it
(`?v=<n>`). There is no delete tool — removing a page is a human action in the UI.

The row and the file both travel between machines: the `graphs` row in the ordinary cloud
snapshot, the `index.html` through `backend/sync/files.py` (`<sync>/graphs/<slug>/`,
sha256-compared; a page edited locally is never overwritten by a pull). The `v<N>.html`
history stays on the machine that made the edit.

Where it shows up: PORT → TOOLS → THESES → **GRAPHS**, and at
`http://bloomberg.localhost:9318/api/v2/graphs/<slug>/render` as a plain link.

Prompts:
- `review_thesis(thesis_id)` — read the thesis, size the position, hunt for evidence
  **against** it, record findings in the knowledge base, log a REVIEW verdict, and
  propose (not apply) any status/conviction change.
- `triage_conflicts(thesis_id?)` — work through unresolved contradictions, compare the
  sources rather than the wording, and propose a resolution for you to accept.

## The knowledge base (Zettelkasten)

`thesis_notes` are notes *about* a thesis. A **zettel** is one idea stated as a sentence,
reusable across theses, with its own sources and typed links to other notes. That is what
makes research an agent did rereadable months later — and what makes conflicting findings
tractable:

- A finding that clashes with something already written is linked `CONTRADICTS`, never
  written over it. The pair stays in **OPEN CONFLICTS** (PORT → TOOLS → THESES → KB) until
  someone records what settled it.
- Resolving writes the reasoning and may mark one side `SUPERSEDES`d — the losing note stays
  readable, because retracing how the view moved is the point.
- Sources are separate rows, so `zettel_by_source` answers "what else rests on this story?"
  when one turns out to be wrong.
- Every zettel carries `actor`; agent-written ones show an `AGENT·<NAME>` tag in the UI.
- `POST /api/v2/zettel/export-md` mirrors the whole base into `OBSIDIAN_WIKI_DIR/zettel/`
  with `[[wikilinks]]`, so Obsidian's graph draws the argument. One-way: the DB stays
  authoritative and a re-export overwrites the vault copy.

## Guard rails

- **No delete tool.** Soft-deleting or purging a thesis stays a human action in the UI.
- `create_thesis` cannot set conviction or a non-draft status.
- Every write sends `X-Thesis-Actor: agent:<MCP_AGENT_NAME>`; the theses router stamps it
  onto the event payload and the timeline renders an `AGENT·<NAME>` tag. Writes from the
  UI carry no header and stay unmarked.
- Tool output is capped at 40 000 chars so one `get_news` call cannot flood the context.
- `zettel_create` refuses a duplicate title (409, naming the existing note) and an EVIDENCE
  note with no source. Resolving a conflict requires written reasoning.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Backend unreachable at http://localhost:9317` | backend not running, or ports were migrated — check `.env.local` / `backend/.env` with `npm run doctor` |
| Server missing after editing config | Desktop only reads the config at launch; quit from the tray and reopen |
| `ModuleNotFoundError: mcp` | the interpreter in `command` is not the one you pip-installed into |
| Timeline shows no `AGENT` tag | backend predates the `X-Thesis-Actor` dependency — restart it |
