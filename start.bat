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

:: Wait 3 seconds for backend to bind
timeout /t 3 /nobreak >nul

:: Start frontend in a new window
start "Bloomberg Frontend :3000" cmd /k "%~dp0start-frontend.bat"

echo  Both windows launched.
echo  Opening browser in 6 seconds...
echo.

timeout /t 6 /nobreak >nul
start http://localhost:3000
