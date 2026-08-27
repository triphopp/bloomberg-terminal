@echo off
:: Bloomberg Terminal - start everything.
:: Thin wrapper around BloombergTerminal.exe (the real launcher, tools\launcher).
:: Builds the exe on first run if it is not there yet.
setlocal
cd /d "%~dp0"

if not exist "BloombergTerminal.exe" (
    echo  Launcher not built yet - building...
    call "tools\launcher\build.bat" || (
        echo.
        echo  Build failed. Falling back to the PowerShell launcher.
        powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\win\start.ps1"
        exit /b
    )
)

start "" "BloombergTerminal.exe" %*
endlocal
