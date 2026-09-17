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

## Tools

| Group | Tools |
|---|---|
| Theses (read) | `list_theses` · `get_thesis` · `notes_due` |
| Theses (write) | `create_thesis` (always `draft`) · `update_thesis` (`reason` required) · `log_event` (NOTE/REVIEW/EVIDENCE/CHECKPOINT) · `add_note` · `update_note` · `link_trade` |
| Portfolio | `get_positions` · `get_trades` |
| Research | `get_stock_data(kind=quote\|financials\|ratios\|estimates\|analyst\|earnings-calendar\|ownership\|management\|dividends\|pe-history\|quality\|sector\|sec-filings)` · `get_price_history` · `get_news` · `get_filings` |
| Knowledge base | `zettel_search` · `zettel_list` · `zettel_get` · `zettel_create` · `zettel_update` · `zettel_link` · `zettel_add_source` · `zettel_attach` · `open_conflicts` · `resolve_conflict` · `zettel_by_source` |

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
