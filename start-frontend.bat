@echo off
title Bloomberg Frontend :3000
cd /d "%~dp0"

echo.
echo  [Frontend] Starting Next.js on port 3000...
echo.

:: Use next.cmd directly — avoids npm.ps1 execution-policy issue
".\node_modules\.bin\next.cmd" dev
pause
