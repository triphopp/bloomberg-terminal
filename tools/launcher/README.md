# BloombergTerminal.exe — Windows launcher

A small native launcher (C / Win32) that starts the whole stack silently and
keeps it in the system tray. Written so the terminal can be registered as a
Windows start-up item without two `cmd` windows popping up on every login.

## What it does

- Starts **backend** (`python -m uvicorn main:app --port 9317`, cwd `backend\`)
  and **frontend** (`node node_modules/next/dist/bin/next dev --port 9318`,
  cwd repo root) as **hidden** processes — no console windows.
- Puts both in a **Job Object** with `KILL_ON_JOB_CLOSE`, so quitting (or
  killing) the launcher tears down uvicorn, next, and everything they spawned.
  No orphaned servers.
- Redirects each server's stdout/stderr to `logs\backend.log` / `logs\frontend.log`.
- Polls `http://127.0.0.1:9317/health` once a second; on the first `200` it
  shows a tray balloon and opens `http://bloomberg.localhost:9318`.
- If a port is **already being served**, it attaches to that server instead of
  spawning a child that would only die with `EADDRINUSE`.
- **Self-heals:** if a server exits, the launcher waits 5s and starts it again,
  up to 3 times; the budget resets once the stack answers `/health`. Only then
  does it give up and say so. Quitting from the tray is not a crash — the
  watchdog is cleared before the children are killed.
- If a server exits on its own, a tray balloon says so and points at its log.
- **Single instance:** launching a second copy just opens the browser (not with
  `--no-browser`, so a duplicate start-up entry stays quiet).

## Tray menu (right-click the icon)

| Item | Effect |
|------|--------|
| Open Terminal | opens `http://bloomberg.localhost:9318` (also: double-click the icon) |
| Backend API docs | opens `http://localhost:9317/docs` |
| Restart servers | kills both children and starts them again |
| Open logs folder | opens `logs\` |
| Run at Windows start-up | toggles `HKCU\...\Run\BloombergTerminal` |
| Quit | stops the servers and exits |

## Build

```bat
tools\launcher\build.bat
```

Needs a **64-bit MinGW-w64** toolchain (`gcc` + `windres`) — the build script
looks in `C:\Strawberry\c\bin`, `C:\msys64\ucrt64\bin`, `C:\msys64\mingw64\bin`,
`C:\mingw64\bin`, then `PATH`. Plain 32-bit MinGW will **not** work: it has no
`-municode`. Output goes to the repo root as `BloombergTerminal.exe`
(gitignored — build it locally).

`start.bat` in the repo root builds the exe automatically the first time, and
falls back to `scripts\win\start.ps1` if no compiler is available.

## Why `bloomberg.localhost`

Browsers resolve any `*.localhost` name to the loopback address themselves
(RFC 6761), so the pretty URL costs nothing: no hosts-file entry, no
certificate, no administrator rights. A `.dev` name cannot work the same way —
`.dev` is on Chrome's preloaded HSTS list, so `http://bloomberg.dev` is
rewritten to `https://` before it ever reaches the dev server and fails. Use
`--host` to point the launcher at some other name if you do set one up.

## Flags

| Flag | Effect |
|------|--------|
| `--no-browser` | don't open the browser when the backend goes healthy |
| `--reload` | run uvicorn with `--reload` (development) |
| `--prod` | run `next start` instead of `next dev` (needs `npm run build` first) |
| `--backend-port N` | backend port (default 9317) |
| `--frontend-port N` | frontend port (default 9318) |
| `--host NAME` | host name to open (default `bloomberg.localhost`) |
| `--root PATH` | repository root — only needed for a copy of the exe that lives outside it |
| `--install-startup` | register in `HKCU\...\Run` and exit |
| `--uninstall-startup` | remove that entry and exit |
| `--stop` | tell a running instance to quit (stops the servers) and exit |

The start-up registration runs the exe with `--no-browser`, so logging into
Windows brings the terminal up quietly in the tray rather than throwing a
browser window at you.

## Starting it automatically

Two mechanisms, both per-user, neither needing administrator rights. Pick one —
enabling both just means the second launch finds the first and exits.

**Scheduled task (recommended)** — `scripts\win\install-startup-task.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\win\install-startup-task.ps1
powershell -ExecutionPolicy Bypass -File scripts\win\install-startup-task.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\win\install-startup-task.ps1 -Uninstall
```

Runs at log-on with a 30s delay (`-DelaySeconds` to change it), restarts the
launcher up to 3 times if it dies, and works on battery. The task passes
`--no-browser --root <repo>`, so it comes up quietly in the tray and never has
to guess where the project is.

**Run key** — the tray's "Run at Windows start-up", or `--install-startup`.
Simpler, no delay, no restart-if-it-dies.

## Do not copy the exe into Start-up

"Run at Windows start-up" writes `HKCU\...\Run` pointing at the exe where it
actually lives, so every rebuild is picked up automatically.

Copying the exe into `shell:startup` instead used to break it outright: the
launcher finds the project by walking up from its own location looking for
`package.json` + `backend\main.py`, and the Start-up folder has neither — so it
built the frontend command against the wrong directory and node answered
`Cannot find module ...\Startup\node_modules\next\dist\bin\next`.

That now degrades gracefully. Whenever the launcher does find the repo it
records the path in `HKCU\Software\BloombergTerminal\Root`, and a copy that
cannot find one of its own falls back to that. So a stray copy works — as long
as the launcher has been run from the repo at least once. Failing everything, it
says so in a dialog instead of starting half a stack, and `--root` sets the path
explicitly.

A copy still goes stale on every rebuild, so the tray toggle remains the right
way to do this.

## Files

| File | Purpose |
|------|---------|
| `launcher.c` | the whole launcher |
| `resource.h` | menu / icon ids |
| `app.rc` | icon + version resource |
| `app.ico` | tray + exe icon - generated, do not hand-edit |
| `build.bat` | compile + link |

## Icon

`app.ico` is generated by `scripts/gen-icons.mjs` (`npm run icons`), which emits
the exe/tray icon and the browser favicon from the same drawing - amber
candlesticks on terminal black - so the launcher and the browser tab match:

| Output | Used by |
|--------|---------|
| `tools/launcher/app.ico` (16/32/48/256) | exe + tray |
| `app/favicon.ico` (16/32/48) | browser tab |
| `app/icon.png` (512) | high-dpi / PWA |
| `app/apple-icon.png` (180) | iOS home screen |

Change the design in `gen-icons.mjs`, run `npm run icons`, then re-run
`build.bat` so the exe picks up the new icon.

`scripts\win\start-backend.bat` and `start-frontend.bat` still exist for
debugging a single server in a **visible** window; `scripts\win\start.ps1` is
the no-compiler fallback.
