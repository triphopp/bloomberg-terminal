# install.ps1 — Install bloomberg command globally on Windows
# Run once: powershell -ExecutionPolicy Bypass -File scripts\install.ps1

$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$SCRIPT_SRC   = "$PROJECT_ROOT\scripts\bloomberg.ps1"
$INSTALL_DIR  = "$env:USERPROFILE\bin"
$WRAPPER_PATH = "$INSTALL_DIR\bloomberg.bat"

Write-Host "Bloomberg Terminal — Global Install" -ForegroundColor Cyan
Write-Host "────────────────────────────────────"

# 1. Create ~/bin if needed
if (-not (Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Force $INSTALL_DIR | Out-Null
    Write-Host "  Created $INSTALL_DIR" -ForegroundColor Yellow
}

# 2. Write a .bat wrapper that calls the PS1 script
$batContent = @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_SRC" %*
"@
$batContent | Set-Content $WRAPPER_PATH -Encoding ASCII
Write-Host "  Created wrapper: $WRAPPER_PATH" -ForegroundColor Green

# 3. Add ~/bin to PATH if not already there (User scope)
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($currentPath -notlike "*$INSTALL_DIR*") {
    [Environment]::SetEnvironmentVariable("PATH", "$currentPath;$INSTALL_DIR", "User")
    Write-Host "  Added $INSTALL_DIR to PATH (User scope)" -ForegroundColor Green
    Write-Host "  Restart terminal or run: `$env:PATH += ';$INSTALL_DIR'" -ForegroundColor Yellow
} else {
    Write-Host "  $INSTALL_DIR already in PATH" -ForegroundColor Green
}

# 4. Allow PS script execution (User scope)
try {
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
    Write-Host "  Set ExecutionPolicy: RemoteSigned (CurrentUser)" -ForegroundColor Green
} catch {
    Write-Host "  Warning: Could not set ExecutionPolicy. Run manually if needed." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host "  Restart your terminal, then run: bloomberg start" -ForegroundColor Cyan
Write-Host ""
Write-Host "  If you use Windows Terminal / PowerShell, you can also add to `$PROFILE:" -ForegroundColor Gray
Write-Host "    function bloomberg { & '$SCRIPT_SRC' @args }" -ForegroundColor Gray
