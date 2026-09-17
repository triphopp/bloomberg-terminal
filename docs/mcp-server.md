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

Prompt: `review_thesis(thesis_id)` — read the thesis, size the position, hunt for evidence
**against** it, record findings as notes, log a REVIEW verdict, and propose (not apply)
any status/conviction change.

## Guard rails

- **No delete tool.** Soft-deleting or purging a thesis stays a human action in the UI.
- `create_thesis` cannot set conviction or a non-draft status.
- Every write sends `X-Thesis-Actor: agent:<MCP_AGENT_NAME>`; the theses router stamps it
  onto the event payload and the timeline renders an `AGENT·<NAME>` tag. Writes from the
  UI carry no header and stay unmarked.
- Tool output is capped at 40 000 chars so one `get_news` call cannot flood the context.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Backend unreachable at http://localhost:9317` | backend not running, or ports were migrated — check `.env.local` / `backend/.env` with `npm run doctor` |
| Server missing after editing config | Desktop only reads the config at launch; quit from the tray and reopen |
| `ModuleNotFoundError: mcp` | the interpreter in `command` is not the one you pip-installed into |
| Timeline shows no `AGENT` tag | backend predates the `X-Thesis-Actor` dependency — restart it |
