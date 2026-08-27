# Register (or remove) the Bloomberg Terminal launcher as a Windows log-on task.
#
#   powershell -ExecutionPolicy Bypass -File scripts\win\install-startup-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\win\install-startup-task.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File scripts\win\install-startup-task.ps1 -Status
#
# A scheduled task rather than the Run key, because it can do three things the
# Run key cannot: wait for the desktop to settle before starting, restart the
# launcher if it ever dies, and run even when the machine is on battery. It
# needs no administrator rights -- the task runs as the current user, in the
# user's session, so the tray icon appears normally and the servers can still
# reach the user's mapped drives (the sync folder lives on one).

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Status,
    [int]$DelaySeconds = 30
)

$ErrorActionPreference = "Stop"

$TaskName = "BloombergTerminal"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Exe      = Join-Path $RepoRoot "BloombergTerminal.exe"

function Get-Task {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# -- Status --------------------------------------------------------------------
if ($Status) {
    $task = Get-Task
    if (-not $task) {
        Write-Host "Not registered." -ForegroundColor Yellow
        exit 0
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Registered." -ForegroundColor Green
    Write-Host "  State       : $($task.State)"
    Write-Host "  Action      : $($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
    Write-Host "  Last run    : $($info.LastRunTime)  (result $($info.LastTaskResult))"
    Write-Host "  Next run    : $($info.NextRunTime)"
    exit 0
}

# -- Uninstall -----------------------------------------------------------------
if ($Uninstall) {
    if (Get-Task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed the '$TaskName' log-on task." -ForegroundColor Green
    } else {
        Write-Host "Nothing to remove -- '$TaskName' is not registered." -ForegroundColor Yellow
    }
    exit 0
}

# -- Install -------------------------------------------------------------------
if (-not (Test-Path $Exe)) {
    Write-Host "[ERROR] $Exe not found. Build it first:" -ForegroundColor Red
    Write-Host "        tools\launcher\build.bat"
    exit 1
}

# --no-browser: logging in should bring the stack up quietly in the tray, not
# throw a browser window at you. --root pins the repo even if the exe is later
# moved or the working directory is somewhere odd.
$action = New-ScheduledTaskAction -Execute $Exe `
    -Argument "--no-browser --root `"$RepoRoot`"" `
    -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT${DelaySeconds}S"   # let the desktop settle first

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # a tray app runs until you quit it

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered '$TaskName'." -ForegroundColor Green
Write-Host "  Runs   : $Exe --no-browser --root `"$RepoRoot`""
Write-Host "  When   : at log-on, ${DelaySeconds}s delay, restarted up to 3x if it dies"
Write-Host ""
Write-Host "The Run-key entry is a separate mechanism -- if you enabled the tray's" -ForegroundColor DarkGray
Write-Host "'Run at Windows start-up' too, remove one of them so it does not start twice:" -ForegroundColor DarkGray
Write-Host "  BloombergTerminal.exe --uninstall-startup" -ForegroundColor DarkGray
