# Bloomberg Terminal — Single startup script
# Usage (bypass execution policy): powershell -ExecutionPolicy Bypass -File .\start.ps1
# Or double-click start.bat which calls this automatically.

param(
    [int]$BackendPort  = 8000,
    [string]$ClippingsDir = "./data/clippings",
    [string]$OllamaUrl    = "http://localhost:11434"
)

$root = $PSScriptRoot

Write-Host ""
Write-Host "  Bloomberg Terminal Launcher" -ForegroundColor Cyan
Write-Host "  Backend  -> http://localhost:$BackendPort" -ForegroundColor DarkGray
Write-Host "  Frontend -> http://localhost:3000" -ForegroundColor DarkGray
Write-Host ""

# ── Check Python ──────────────────────────────────────────────────────────────
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "  [ERROR] python not found in PATH" -ForegroundColor Red; exit 1
}

# ── Check Node ────────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [ERROR] node not found in PATH" -ForegroundColor Red; exit 1
}

# ── Check if npm deps are installed ───────────────────────────────────────────
if (-not (Test-Path "$root\node_modules")) {
    Write-Host "  [INFO] node_modules not found — running npm install..." -ForegroundColor Yellow
    cmd /c "cd /d `"$root`" && npm install --silent"
}

# ── Backend: new cmd window ────────────────────────────────────────────────────
# Uses cmd.exe so it avoids PowerShell execution-policy issues entirely.
$backendCmd = "cd /d `"$root\backend`" && " +
    "set CLIPPINGS_DIR=$ClippingsDir && " +
    "set OLLAMA_URL=$OllamaUrl && " +
    "python -m uvicorn main:app --port $BackendPort --reload"

Write-Host "  [1/2] Starting backend (cmd window)..." -ForegroundColor Green
Start-Process cmd -ArgumentList "/k", "title Bloomberg Backend :$BackendPort && $backendCmd"

Start-Sleep -Seconds 2   # give backend a moment to bind port

# ── Frontend: new cmd window ───────────────────────────────────────────────────
# node.exe directly instead of npm.ps1 → no execution-policy issue
$nextBin = "$root\node_modules\.bin\next.cmd"
$frontendCmd = if (Test-Path $nextBin) {
    "cd /d `"$root`" && `"$nextBin`" dev"
} else {
    # Fallback: use node_modules/.bin/next via npx (cmd-safe)
    "cd /d `"$root`" && npx next dev"
}

Write-Host "  [2/2] Starting frontend (cmd window)..." -ForegroundColor Cyan
Start-Process cmd -ArgumentList "/k", "title Bloomberg Frontend :3000 && $frontendCmd"

Write-Host ""
Write-Host "  Both processes launched in separate cmd windows." -ForegroundColor White
Write-Host "  Open http://localhost:3000 in your browser." -ForegroundColor White
Write-Host ""
Write-Host "  To stop: close the two cmd windows, or press Ctrl+C in each." -ForegroundColor DarkGray

# ── Auto-open browser after 6s ─────────────────────────────────────────────────
Write-Host "  Opening browser in 6 seconds..." -ForegroundColor DarkGray
Start-Sleep -Seconds 6
Start-Process "http://localhost:3000"
