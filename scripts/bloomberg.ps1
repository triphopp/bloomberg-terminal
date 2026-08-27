# bloomberg.ps1 — Bloomberg Terminal launcher (Windows)
# Usage: bloomberg [start|stop|status|logs|restart|open]
# Install globally: Run scripts\install.ps1 once

param(
    [Parameter(Position=0)]
    [ValidateSet("start","stop","status","logs","restart","open","help")]
    [string]$Command = "start"
)

# ── Paths ─────────────────────────────────────────────────────────────────────
$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$PID_FILE     = "$env:TEMP\bloomberg-terminal.pids"
$LOG_DIR      = "$PROJECT_ROOT\logs"
$BACKEND_LOG  = "$LOG_DIR\backend.log"
$FRONTEND_LOG = "$LOG_DIR\frontend.log"

# ── Env vars (edit to match your machine) ────────────────────────────────────
$ENV_VARS = @{
    CLIPPINGS_DIR = $env:CLIPPINGS_DIR  ?? "./data/clippings"
    THESES_DIR    = $env:THESES_DIR     ?? "./data/theses"
    SOURCES_DIR   = $env:SOURCES_DIR    ?? "./data/sources"
    OLLAMA_URL    = $env:OLLAMA_URL     ?? "http://localhost:11434"
}

# ── Colors ────────────────────────────────────────────────────────────────────
function Write-Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green  }
function Write-Err  { param($m) Write-Host " [ERR] $m" -ForegroundColor Red    }
function Write-Info { param($m) Write-Host "  [..] $m" -ForegroundColor Yellow }

# ── Helpers ───────────────────────────────────────────────────────────────────
function Ensure-LogDir {
    if (-not (Test-Path $LOG_DIR)) {
        New-Item -ItemType Directory -Force $LOG_DIR | Out-Null
    }
}

function Get-StoredPids {
    if (Test-Path $PID_FILE) {
        $content = Get-Content $PID_FILE -Raw
        $pids = @{}
        foreach ($line in ($content -split "`n")) {
            $parts = $line.Trim() -split "="
            if ($parts.Count -eq 2) { $pids[$parts[0].Trim()] = [int]$parts[1].Trim() }
        }
        return $pids
    }
    return @{}
}

function Is-Running {
    param([int]$Pid)
    try {
        $proc = Get-Process -Id $Pid -ErrorAction Stop
        return $true
    } catch { return $false }
}

# ── Commands ──────────────────────────────────────────────────────────────────
function Start-Bloomberg {
    $stored = Get-StoredPids
    if ($stored.Count -gt 0) {
        $backendOk  = $stored.ContainsKey("backend")  -and (Is-Running $stored["backend"])
        $frontendOk = $stored.ContainsKey("frontend") -and (Is-Running $stored["frontend"])
        if ($backendOk -and $frontendOk) {
            Write-Info "Already running. Use 'bloomberg status' to check."
            return
        }
    }

    Ensure-LogDir

    # Set env vars
    foreach ($kv in $ENV_VARS.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
    }

    Write-Info "Starting backend  (port $BACKEND_PORT) ..."
    $backendDir  = "$PROJECT_ROOT\backend"
    $backendProc = Start-Process powershell -ArgumentList @(
        "-NoProfile", "-Command",
        "cd '$backendDir'; " +
        ($ENV_VARS.GetEnumerator() | ForEach-Object { "`$env:$($_.Key) = '$($_.Value)'; " }) +
        "python -m uvicorn main:app --port $BACKEND_PORT --reload *>> '$BACKEND_LOG' 2>&1"
    ) -WindowStyle Hidden -PassThru
    Write-Ok "Backend PID: $($backendProc.Id)"

    Start-Sleep -Milliseconds 2000

    Write-Info "Starting frontend (port $FRONTEND_PORT) ..."
    $frontendProc = Start-Process powershell -ArgumentList @(
        "-NoProfile", "-Command",
        "cd '$PROJECT_ROOT'; npm run dev *>> '$FRONTEND_LOG' 2>&1"
    ) -WindowStyle Hidden -PassThru
    Write-Ok "Frontend PID: $($frontendProc.Id)"

    # Save PIDs
    "backend=$($backendProc.Id)`nfrontend=$($frontendProc.Id)" | Set-Content $PID_FILE

    Start-Sleep -Milliseconds 3000
    Write-Ok "Bloomberg Terminal running at http://localhost:$FRONTEND_PORT"
    Write-Info "Logs: $LOG_DIR"
    Write-Info "Run 'bloomberg open' to launch in browser"
}

function Stop-Bloomberg {
    $stored = Get-StoredPids
    if ($stored.Count -eq 0) {
        Write-Info "No running instance found."
        return
    }

    foreach ($name in $stored.Keys) {
        $pid = $stored[$name]
        if (Is-Running $pid) {
            try {
                # Kill process tree
                $children = Get-WmiObject Win32_Process | Where-Object { $_.ParentProcessId -eq $pid }
                foreach ($child in $children) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
                Stop-Process -Id $pid -Force
                Write-Ok "Stopped $name (PID $pid)"
            } catch {
                Write-Err "Failed to stop $name (PID $pid): $_"
            }
        } else {
            Write-Info "$name (PID $pid) was not running"
        }
    }

    Remove-Item $PID_FILE -ErrorAction SilentlyContinue
    Write-Ok "Bloomberg Terminal stopped"
}

function Show-Status {
    $stored = Get-StoredPids
    if ($stored.Count -eq 0) {
        Write-Info "Bloomberg Terminal: STOPPED"
        return
    }

    Write-Host "`n  Bloomberg Terminal Status" -ForegroundColor Cyan
    Write-Host "  ─────────────────────────"
    foreach ($name in $stored.Keys) {
        $pid = $stored[$name]
        if (Is-Running $pid) {
            $proc = Get-Process -Id $pid
            $mem  = [math]::Round($proc.WorkingSet64 / 1MB, 1)
            Write-Host "  $($name.PadRight(10)) " -NoNewline
            Write-Host "RUNNING" -ForegroundColor Green -NoNewline
            Write-Host "  PID=$pid  MEM=${mem}MB"
        } else {
            Write-Host "  $($name.PadRight(10)) " -NoNewline
            Write-Host "STOPPED" -ForegroundColor Red -NoNewline
            Write-Host "  PID=$pid (stale)"
        }
    }
    Write-Host "  ─────────────────────────"
    Write-Host "  Frontend: http://localhost:$FRONTEND_PORT"
    Write-Host "  Backend:  http://localhost:$BACKEND_PORT/health"
    Write-Host "  Logs:     $LOG_DIR`n"
}

function Show-Logs {
    param([string]$Service = "both")
    if ($Service -eq "backend" -or $Service -eq "both") {
        Write-Host "── BACKEND (last 40 lines) ──────────────────────" -ForegroundColor Yellow
        if (Test-Path $BACKEND_LOG) { Get-Content $BACKEND_LOG -Tail 40 } else { Write-Info "No backend log yet" }
    }
    if ($Service -eq "frontend" -or $Service -eq "both") {
        Write-Host "── FRONTEND (last 40 lines) ─────────────────────" -ForegroundColor Cyan
        if (Test-Path $FRONTEND_LOG) { Get-Content $FRONTEND_LOG -Tail 40 } else { Write-Info "No frontend log yet" }
    }
}

function Open-Browser {
    Start-Process "http://bloomberg.localhost:$FRONTEND_PORT"
}

function Show-Help {
    Write-Host @"

  bloomberg  — Bloomberg Terminal launcher

  Commands:
    bloomberg start    Start backend + frontend in background (default)
    bloomberg stop     Stop all processes
    bloomberg status   Show running status + memory usage
    bloomberg logs     Show recent logs (both services)
    bloomberg restart  Stop then start
    bloomberg open     Open the terminal in your browser
    bloomberg help     Show this help

  Logs stored in: $LOG_DIR
  PIDs stored in: $PID_FILE

"@ -ForegroundColor Cyan
}

# ── Main ──────────────────────────────────────────────────────────────────────
switch ($Command) {
    "start"   { Start-Bloomberg }
    "stop"    { Stop-Bloomberg  }
    "status"  { Show-Status     }
    "logs"    { Show-Logs       }
    "restart" { Stop-Bloomberg; Start-Sleep 1; Start-Bloomberg }
    "open"    { Open-Browser    }
    "help"    { Show-Help       }
}
