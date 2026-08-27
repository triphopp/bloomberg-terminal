@echo off
:: Build the Bloomberg Terminal launcher.
:: Requires a 64-bit MinGW-w64 toolchain (gcc + windres). Strawberry Perl ships
:: one at C:\Strawberry\c\bin. Plain 32-bit MinGW does NOT work (no -municode).
:: Output: <repo root>\BloombergTerminal.exe
setlocal
cd /d "%~dp0"

set "CC="
for %%D in ("C:\Strawberry\c\bin" "C:\msys64\ucrt64\bin" "C:\msys64\mingw64\bin" "C:\mingw64\bin") do (
    if exist "%%~D\gcc.exe" if not defined CC set "CC=%%~D"
)
if not defined CC (
    where gcc >nul 2>&1 && set "CC=path"
)
if not defined CC (
    echo [ERROR] No MinGW-w64 gcc found. Install MSYS2 or Strawberry Perl.
    exit /b 1
)

if "%CC%"=="path" (
    set "GCC=gcc"
    set "WINDRES=windres"
) else (
    set "GCC=%CC%\gcc.exe"
    set "WINDRES=%CC%\windres.exe"
)

echo  Toolchain: %GCC%
echo  [1/2] Compiling resources...
"%WINDRES%" app.rc -O coff -o app.res || exit /b 1

echo  [2/2] Linking BloombergTerminal.exe...
"%GCC%" -O2 -municode -mwindows -Wall -o "..\..\BloombergTerminal.exe" launcher.c app.res ^
    -lshell32 -lwinhttp -ladvapi32 -luser32 -lgdi32 -lws2_32 || exit /b 1

del app.res >nul 2>&1
echo.
echo  Built: %~dp0..\..\BloombergTerminal.exe
endlocal
