@echo off
:: Bloomberg Terminal — Double-click this to start everything
:: Opens Backend + Frontend in separate windows.
cd /d "%~dp0"

echo.
echo  Bloomberg Terminal Launcher
echo  Backend  -^> http://localhost:8000
echo  Frontend -^> http://localhost:3000
echo.

:: Start backend in a new window
start "Bloomberg Backend :8000" cmd /k "%~dp0start-backend.bat"

:: Poll /health until backend is ready (up to 30s)
echo  Waiting for backend...
powershell -NoProfile -Command ^
  "$ok=$false; for($i=0;$i-lt30;$i++){Start-Sleep 1; try{$r=Invoke-WebRequest -Uri 'http://localhost:8000/health' -TimeoutSec 1 -UseBasicParsing -EA Stop; if($r.StatusCode-eq200){$ok=$true;break}}catch{} Write-Host '.' -NoNewline}; Write-Host ''; if(-not $ok){Write-Host '[WARN] backend not ready'}"

:: Start frontend in a new window
start "Bloomberg Frontend :3000" cmd /k "%~dp0start-frontend.bat"

echo  Both windows launched.
echo  Opening browser in 6 seconds...
echo.

timeout /t 6 /nobreak >nul
start http://localhost:3000
