@echo off
title Bloomberg Backend :9317
cd /d "%~dp0..\..ackend"

:: Load .env file if it exists
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        set "%%A=%%B"
    )
)

:: Defaults if not set in .env
if not defined CLIPPINGS_DIR set "CLIPPINGS_DIR=./data/clippings"
if not defined OLLAMA_URL    set "OLLAMA_URL=http://localhost:11434"

echo.
echo  [Backend] Starting FastAPI on port 9317...
echo  CLIPPINGS_DIR = %CLIPPINGS_DIR%
echo  OLLAMA_URL    = %OLLAMA_URL%
echo.

python -m uvicorn main:app --port 9317 --reload
pause
