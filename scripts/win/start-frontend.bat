@echo off
:: Frontend only, in a visible window (debugging).
:: Normal start-up goes through BloombergTerminal.exe in the repo root.
title Bloomberg Frontend :9318
cd /d "%~dp0..\.."

echo.
echo  [Frontend] Starting Next.js on port 9318...
echo.

:: next.cmd directly - avoids the npm.ps1 execution-policy issue
"node_modules\.bin\next.cmd" dev --port 9318
pause
