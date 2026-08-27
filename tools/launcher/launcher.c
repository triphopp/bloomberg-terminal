/*
 * Bloomberg Terminal — Windows launcher
 *
 * A silent (no console window) launcher that starts the FastAPI backend and the
 * Next.js frontend as hidden child processes, waits for the backend /health
 * endpoint, then optionally opens the browser. It lives in the notification
 * area (system tray) so the whole stack can be opened, restarted or stopped
 * from one place, and it is safe to register as a Windows start-up item.
 *
 * Both children are placed in a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
 * so closing the launcher (or killing it) always tears the servers down too —
 * no orphaned uvicorn/node processes.
 *
 * Build: see build.bat (MinGW gcc) in this directory.
 *
 * Command line flags:
 *   --no-browser        do not open the browser once the backend is healthy
 *   --reload            run uvicorn with --reload (development)
 *   --prod              run `next start` instead of `next dev`
 *   --backend-port N    backend port (default 9317)
 *   --frontend-port N   frontend port (default 9318)
 *   --host NAME         host name to open (default bloomberg.localhost)
 *   --root PATH         repository root (only needed if the exe lives outside it)
 *   --install-startup   register in HKCU\...\Run and exit
 *   --uninstall-startup remove the HKCU\...\Run entry and exit
 *   --stop              signal a running launcher instance to quit and exit
 */

#include <winsock2.h>   /* must precede windows.h */
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "resource.h"

#define APP_NAME        L"Bloomberg Terminal"
#define MUTEX_NAME      L"Local\\BloombergTerminalLauncher"
#define WNDCLASS_NAME   L"BloombergTerminalLauncherWnd"
#define RUNKEY_PATH     L"Software\\Microsoft\\Windows\\CurrentVersion\\Run"
#define RUNKEY_VALUE    L"BloombergTerminal"
/* Remembers where the repo is, so a copy of the exe parked somewhere with no
 * package.json above it (the Start-up folder, a Desktop copy) still works. */
#define ROOTKEY_PATH    L"Software\\BloombergTerminal"
#define ROOTKEY_VALUE   L"Root"

/* ── configuration resolved at start-up ─────────────────────────────────── */
static wchar_t g_root[MAX_PATH];          /* repository root                 */
static wchar_t g_rootArg[MAX_PATH];       /* --root PATH, empty when unused  */
static wchar_t g_logDir[MAX_PATH];        /* <root>\logs                     */
static int     g_backendPort  = 9317;
static int     g_frontendPort = 9318;
/* The name the browser opens. `*.localhost` is mapped to the loopback address
 * by the browser itself (RFC 6761), so this needs no hosts-file entry and no
 * certificate — unlike a `.dev` name, which Chrome's preloaded HSTS list
 * forces onto HTTPS and would therefore refuse to load over plain HTTP. */
static wchar_t g_host[64]     = L"bloomberg.localhost";
static BOOL    g_openBrowser  = TRUE;
static BOOL    g_reload       = FALSE;
static BOOL    g_prod         = FALSE;

/* ── runtime state ──────────────────────────────────────────────────────── */
static HANDLE  g_job          = NULL;
static HANDLE  g_backendProc  = NULL;
static HANDLE  g_frontendProc = NULL;
static BOOL    g_backendExternal  = FALSE;  /* port was already being served */
static BOOL    g_frontendExternal = FALSE;
/* Self-heal: a server that dies is restarted a few times before the launcher
 * gives up and just reports it. Attempts reset once the stack is healthy again,
 * so a process that dies once a week never exhausts the budget, while one that
 * cannot start at all (bad config, missing dependency) stops thrashing. */
static DWORD   g_backendDiedAt    = 0;   /* GetTickCount when noticed, 0 = alive */
static DWORD   g_frontendDiedAt   = 0;
static int     g_backendRestarts  = 0;
static int     g_frontendRestarts = 0;
static BOOL    g_gaveUp           = FALSE;
static HWND    g_hwnd         = NULL;
static NOTIFYICONDATAW g_nid;
static BOOL    g_healthy      = FALSE;

/* ───────────────────────────── helpers ─────────────────────────────────── */

static void notify(const wchar_t *title, const wchar_t *text)
{
    NOTIFYICONDATAW n = g_nid;
    n.uFlags = NIF_INFO;
    n.dwInfoFlags = NIIF_INFO;
    wcsncpy(n.szInfoTitle, title, ARRAYSIZE(n.szInfoTitle) - 1);
    wcsncpy(n.szInfo, text, ARRAYSIZE(n.szInfo) - 1);
    Shell_NotifyIconW(NIM_MODIFY, &n);
}

static void setTip(const wchar_t *text)
{
    wcsncpy(g_nid.szTip, text, ARRAYSIZE(g_nid.szTip) - 1);
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

/* A directory is the repo root if it holds package.json AND backend\main.py --
 * package.json alone would happily match some unrelated Node project. */
static BOOL isRepoRoot(const wchar_t *dir)
{
    wchar_t probe[MAX_PATH];
    _snwprintf(probe, MAX_PATH, L"%s\\package.json", dir);
    if (GetFileAttributesW(probe) == INVALID_FILE_ATTRIBUTES) return FALSE;
    _snwprintf(probe, MAX_PATH, L"%s\\backend\\main.py", dir);
    return GetFileAttributesW(probe) != INVALID_FILE_ATTRIBUTES;
}

static void rememberRoot(const wchar_t *dir)
{
    HKEY k;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, ROOTKEY_PATH, 0, NULL, 0,
                        KEY_WRITE, NULL, &k, NULL) != ERROR_SUCCESS) return;
    RegSetValueExW(k, ROOTKEY_VALUE, 0, REG_SZ, (const BYTE *)dir,
                   (DWORD)((wcslen(dir) + 1) * sizeof(wchar_t)));
    RegCloseKey(k);
}

static BOOL recallRoot(wchar_t *out, DWORD cch)
{
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, ROOTKEY_PATH, 0, KEY_READ, &k) != ERROR_SUCCESS)
        return FALSE;
    DWORD bytes = cch * sizeof(wchar_t), type = 0;
    LONG rc = RegQueryValueExW(k, ROOTKEY_VALUE, NULL, &type, (BYTE *)out, &bytes);
    RegCloseKey(k);
    if (rc != ERROR_SUCCESS || type != REG_SZ) return FALSE;
    out[cch - 1] = 0;
    return isRepoRoot(out);
}

/* Locate the repository: --root wins, then the nearest directory at or above
 * the exe, then whatever a previous run recorded. Returns FALSE when none of
 * those is a repo, so the caller can say so instead of starting servers that
 * would only fail with a module-not-found buried in a log file. */
static BOOL resolveRoot(void)
{
    if (g_rootArg[0] && isRepoRoot(g_rootArg)) {
        wcsncpy(g_root, g_rootArg, MAX_PATH - 1);
        rememberRoot(g_root);
        return TRUE;
    }

    wchar_t exe[MAX_PATH];
    GetModuleFileNameW(NULL, exe, MAX_PATH);
    wchar_t *slash = wcsrchr(exe, L'\\');
    if (slash) *slash = 0;

    wcsncpy(g_root, exe, MAX_PATH - 1);
    for (int up = 0; up < 4; up++) {
        if (isRepoRoot(g_root)) {
            rememberRoot(g_root);
            return TRUE;
        }
        wchar_t *t = wcsrchr(g_root, L'\\');
        if (!t) break;
        *t = 0;
    }

    return recallRoot(g_root, MAX_PATH);
}

/* Resolve an executable through PATH. Returns TRUE and fills out[] on success. */
static BOOL findExe(const wchar_t *name, wchar_t *out, DWORD cch)
{
    DWORD n = SearchPathW(NULL, name, L".exe", cch, out, NULL);
    return n > 0 && n < cch;
}

static HANDLE openLog(const wchar_t *file)
{
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    wchar_t path[MAX_PATH];
    _snwprintf(path, MAX_PATH, L"%s\\%s", g_logDir, file);
    HANDLE h = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    return (h == INVALID_HANDLE_VALUE) ? NULL : h;
}

/* Spawn a hidden child process inside the job object, output redirected to a
 * log file. cmdline is modified in place by CreateProcessW, so pass a buffer. */
static HANDLE spawn(wchar_t *cmdline, const wchar_t *cwd, const wchar_t *logFile)
{
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE log = openLog(logFile);

    /* A real NUL handle, not INVALID_HANDLE_VALUE: a child that shells out
     * (joblib probing the CPU count, npm, anything using subprocess) calls
     * GetStdHandle(STD_INPUT_HANDLE) and dies on an invalid one. */
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             &sa, OPEN_EXISTING, 0, NULL);
    if (nul == INVALID_HANDLE_VALUE) nul = NULL;

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    if (log) {
        si.dwFlags |= STARTF_USESTDHANDLES;
        si.hStdOutput = log;
        si.hStdError  = log;
        si.hStdInput  = nul;
    }

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));

    BOOL ok = CreateProcessW(NULL, cmdline, NULL, NULL, log ? TRUE : FALSE,
                             CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB,
                             NULL, cwd, &si, &pi);
    if (!ok) {
        /* Some hosts forbid breakaway; retry without that flag. */
        ok = CreateProcessW(NULL, cmdline, NULL, NULL, log ? TRUE : FALSE,
                            CREATE_NO_WINDOW | CREATE_SUSPENDED,
                            NULL, cwd, &si, &pi);
    }
    if (log) CloseHandle(log);
    if (nul) CloseHandle(nul);
    if (!ok) return NULL;

    if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    return pi.hProcess;
}

/* TRUE if something is already listening on 127.0.0.1:<port>. */
static BOOL portOpen(int port)
{
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return FALSE;

    BOOL open = FALSE;
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s != INVALID_SOCKET) {
        struct sockaddr_in a;
        ZeroMemory(&a, sizeof(a));
        a.sin_family = AF_INET;
        a.sin_port = htons((u_short)port);
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        DWORD tmo = 400;
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tmo, sizeof(tmo));
        open = connect(s, (struct sockaddr *)&a, sizeof(a)) == 0;
        closesocket(s);
    }
    WSACleanup();
    return open;
}

/* GET http://127.0.0.1:<port>/health — TRUE on HTTP 200. */
static BOOL checkHealth(void)
{
    BOOL ok = FALSE;
    HINTERNET s = WinHttpOpen(L"BloombergLauncher/1.0",
                              WINHTTP_ACCESS_TYPE_NO_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!s) return FALSE;
    WinHttpSetTimeouts(s, 1000, 1000, 1000, 1000);

    HINTERNET c = WinHttpConnect(s, L"127.0.0.1", (INTERNET_PORT)g_backendPort, 0);
    if (c) {
        HINTERNET r = WinHttpOpenRequest(c, L"GET", L"/health", NULL,
                                         WINHTTP_NO_REFERER,
                                         WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
        if (r) {
            if (WinHttpSendRequest(r, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                   WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
                WinHttpReceiveResponse(r, NULL)) {
                DWORD code = 0, len = sizeof(code);
                WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                    WINHTTP_HEADER_NAME_BY_INDEX, &code, &len, WINHTTP_NO_HEADER_INDEX);
                ok = (code == 200);
            }
            WinHttpCloseHandle(r);
        }
        WinHttpCloseHandle(c);
    }
    WinHttpCloseHandle(s);
    return ok;
}

static void openFrontend(void)
{
    wchar_t url[128];
    _snwprintf(url, 128, L"http://%s:%d", g_host, g_frontendPort);
    ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
}

/* ── start-up registration (HKCU Run) ───────────────────────────────────── */

static BOOL startupEnabled(void)
{
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, RUNKEY_PATH, 0, KEY_READ, &k) != ERROR_SUCCESS)
        return FALSE;
    BOOL found = RegQueryValueExW(k, RUNKEY_VALUE, NULL, NULL, NULL, NULL) == ERROR_SUCCESS;
    RegCloseKey(k);
    return found;
}

static BOOL startupInstall(void)
{
    wchar_t exe[MAX_PATH], value[MAX_PATH + 32];
    GetModuleFileNameW(NULL, exe, MAX_PATH);
    _snwprintf(value, ARRAYSIZE(value), L"\"%s\" --no-browser", exe);

    HKEY k;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, RUNKEY_PATH, 0, NULL, 0,
                        KEY_WRITE, NULL, &k, NULL) != ERROR_SUCCESS) return FALSE;
    LONG rc = RegSetValueExW(k, RUNKEY_VALUE, 0, REG_SZ,
                             (const BYTE *)value,
                             (DWORD)((wcslen(value) + 1) * sizeof(wchar_t)));
    RegCloseKey(k);
    return rc == ERROR_SUCCESS;
}

static void startupUninstall(void)
{
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, RUNKEY_PATH, 0, KEY_WRITE, &k) == ERROR_SUCCESS) {
        RegDeleteValueW(k, RUNKEY_VALUE);
        RegCloseKey(k);
    }
}

/* ── process management ─────────────────────────────────────────────────── */

#define MAX_RESTARTS     3
#define RESTART_DELAY_MS 5000

/* Backend: python -m uvicorn main:app --port N [--reload] */
static void startBackend(void)
{
    wchar_t python[MAX_PATH], cmd[2048], cwd[MAX_PATH];
    if (g_backendExternal) return;
    if (!findExe(L"python.exe", python, MAX_PATH) && !findExe(L"py.exe", python, MAX_PATH)) {
        notify(APP_NAME, L"python was not found on PATH.");
        return;
    }
    _snwprintf(cwd, MAX_PATH, L"%s\\backend", g_root);
    _snwprintf(cmd, ARRAYSIZE(cmd), L"\"%s\" -m uvicorn main:app --port %d%s",
               python, g_backendPort, g_reload ? L" --reload" : L"");
    g_backendProc = spawn(cmd, cwd, L"backend.log");
    g_backendDiedAt = 0;
}

/* Frontend: node node_modules/next/dist/bin/next dev|start --port N */
static void startFrontend(void)
{
    wchar_t node[MAX_PATH], cmd[2048], nextBin[MAX_PATH];
    if (g_frontendExternal) return;
    if (!findExe(L"node.exe", node, MAX_PATH)) {
        notify(APP_NAME, L"node was not found on PATH.");
        return;
    }
    _snwprintf(nextBin, MAX_PATH, L"%s\\node_modules\\next\\dist\\bin\\next", g_root);

    /* Without this check node reports MODULE_NOT_FOUND into frontend.log and
     * the tray just sits there saying "starting". Say it out loud. */
    if (GetFileAttributesW(nextBin) == INVALID_FILE_ATTRIBUTES) {
        notify(APP_NAME, L"next is not installed in this project. "
                         L"Run npm install in the repository first.");
        setTip(APP_NAME L" - dependencies missing");
        return;
    }
    _snwprintf(cmd, ARRAYSIZE(cmd), L"\"%s\" \"%s\" %s --port %d",
               node, nextBin, g_prod ? L"start" : L"dev", g_frontendPort);
    g_frontendProc = spawn(cmd, g_root, L"frontend.log");
    g_frontendDiedAt = 0;
}

static void startServers(void)
{
    g_backendRestarts = g_frontendRestarts = 0;
    g_backendDiedAt = g_frontendDiedAt = 0;
    g_gaveUp = FALSE;

    /* A port that already answers belongs to a server someone else started -
     * a manual `npm run dev`, or a previous launcher. Attach to it instead of
     * spawning a child that would only die with EADDRINUSE. */
    g_backendExternal  = portOpen(g_backendPort);
    g_frontendExternal = portOpen(g_frontendPort);

    startBackend();
    startFrontend();
}

static void stopServers(void)
{
    /* Deliberate: clear the death marks first so the timer does not read the
     * kill below as a crash and helpfully restart what we just stopped. */
    g_backendDiedAt = g_frontendDiedAt = 0;

    if (g_backendProc)  { TerminateProcess(g_backendProc, 0);  CloseHandle(g_backendProc);  g_backendProc = NULL; }
    if (g_frontendProc) { TerminateProcess(g_frontendProc, 0); CloseHandle(g_frontendProc); g_frontendProc = NULL; }
    /* Closing the job kills anything the children spawned (uvicorn reloader,
     * next's worker processes). Recreate it for a later restart. */
    if (g_job) {
        CloseHandle(g_job);
        g_job = CreateJobObjectW(NULL, NULL);
        if (g_job) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION li;
            ZeroMemory(&li, sizeof(li));
            li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &li, sizeof(li));
        }
    }
}

/* ── tray menu ──────────────────────────────────────────────────────────── */

static void showMenu(void)
{
    HMENU m = CreatePopupMenu();
    wchar_t open[128], api[64];
    _snwprintf(open, 128, L"Open Terminal  (%s:%d)", g_host, g_frontendPort);
    _snwprintf(api,  64, L"Backend API docs  (:%d)", g_backendPort);

    AppendMenuW(m, MF_STRING | (g_healthy ? 0 : MF_GRAYED), IDM_OPEN, open);
    AppendMenuW(m, MF_STRING, IDM_APIDOCS, api);
    AppendMenuW(m, MF_SEPARATOR, 0, NULL);
    AppendMenuW(m, MF_STRING, IDM_RESTART, L"Restart servers");
    AppendMenuW(m, MF_STRING, IDM_LOGS,    L"Open logs folder");
    AppendMenuW(m, MF_SEPARATOR, 0, NULL);
    AppendMenuW(m, MF_STRING | (startupEnabled() ? MF_CHECKED : 0), IDM_STARTUP,
                L"Run at Windows start-up");
    AppendMenuW(m, MF_SEPARATOR, 0, NULL);
    AppendMenuW(m, MF_STRING, IDM_QUIT, L"Quit (stops servers)");

    POINT p;
    GetCursorPos(&p);
    SetForegroundWindow(g_hwnd);
    TrackPopupMenu(m, TPM_RIGHTBUTTON, p.x, p.y, 0, g_hwnd, NULL);
    PostMessageW(g_hwnd, WM_NULL, 0, 0);
    DestroyMenu(m);
}

/* ── window proc ────────────────────────────────────────────────────────── */

#define TIMER_HEALTH 1
static int g_healthTicks = 0;

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    switch (msg) {
    case WM_TRAYICON:
        if (LOWORD(lp) == WM_RBUTTONUP || LOWORD(lp) == WM_CONTEXTMENU) showMenu();
        else if (LOWORD(lp) == WM_LBUTTONDBLCLK) openFrontend();
        return 0;

    case WM_TIMER:
        if (wp == TIMER_HEALTH) {
            DWORD now = GetTickCount();

            /* Notice a child that exited on its own. The servers run hidden, so
             * the tray is the only place this could ever be reported. */
            if (g_backendProc && WaitForSingleObject(g_backendProc, 0) == WAIT_OBJECT_0) {
                CloseHandle(g_backendProc);
                g_backendProc = NULL;
                g_backendDiedAt = now;
                g_healthy = FALSE;
                setTip(APP_NAME L" - backend stopped");
            }
            if (g_frontendProc && WaitForSingleObject(g_frontendProc, 0) == WAIT_OBJECT_0) {
                CloseHandle(g_frontendProc);
                g_frontendProc = NULL;
                g_frontendDiedAt = now;
                setTip(APP_NAME L" - frontend stopped");
            }

            /* Bring it back. The delay keeps a crash-on-start from spinning. */
            if (g_backendDiedAt && now - g_backendDiedAt >= RESTART_DELAY_MS) {
                if (g_backendRestarts < MAX_RESTARTS) {
                    g_backendRestarts++;
                    notify(APP_NAME, L"Backend stopped - restarting it.");
                    g_healthTicks = 0;
                    startBackend();
                } else if (!g_gaveUp) {
                    g_gaveUp = TRUE;
                    g_backendDiedAt = 0;
                    setTip(APP_NAME L" - backend keeps failing");
                    notify(APP_NAME, L"Backend failed to stay up after 3 restarts. "
                                     L"See logs\\backend.log.");
                }
            }
            if (g_frontendDiedAt && now - g_frontendDiedAt >= RESTART_DELAY_MS) {
                if (g_frontendRestarts < MAX_RESTARTS) {
                    g_frontendRestarts++;
                    notify(APP_NAME, L"Frontend stopped - restarting it.");
                    startFrontend();
                } else if (!g_gaveUp) {
                    g_gaveUp = TRUE;
                    g_frontendDiedAt = 0;
                    setTip(APP_NAME L" - frontend keeps failing");
                    notify(APP_NAME, L"Frontend failed to stay up after 3 restarts. "
                                     L"See logs\\frontend.log.");
                }
            }

            if (!g_healthy && !g_gaveUp) {
                g_healthTicks++;
                if (checkHealth()) {
                    g_healthy = TRUE;
                    /* A stack that came back up earns its restart budget back. */
                    g_backendRestarts = g_frontendRestarts = 0;
                    setTip(APP_NAME L" - running");
                    notify(APP_NAME,
                           (g_backendExternal || g_frontendExternal)
                           ? L"Running. Attached to a server that was already up."
                           : L"Backend and frontend are up.");
                    if (g_openBrowser) openFrontend();
                } else if (g_healthTicks == 60) {
                    setTip(APP_NAME L" - backend not responding");
                    notify(APP_NAME, L"Backend did not answer /health after 60s. "
                                     L"Check logs\\backend.log.");
                }
            }
        }
        return 0;

    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case IDM_OPEN:    openFrontend(); break;
        case IDM_APIDOCS: {
            wchar_t url[128];
            _snwprintf(url, 128, L"http://localhost:%d/docs", g_backendPort);
            ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
            break;
        }
        case IDM_RESTART:
            stopServers();
            g_healthy = FALSE;
            g_healthTicks = 0;
            setTip(APP_NAME L" — restarting...");
            startServers();
            break;
        case IDM_LOGS:
            ShellExecuteW(NULL, L"open", g_logDir, NULL, NULL, SW_SHOWNORMAL);
            break;
        case IDM_STARTUP:
            if (startupEnabled()) {
                startupUninstall();
                notify(APP_NAME, L"Removed from Windows start-up.");
            } else if (startupInstall()) {
                notify(APP_NAME, L"Will now start with Windows.");
            }
            break;
        case IDM_QUIT:
            DestroyWindow(hwnd);
            break;
        }
        return 0;

    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;

    case WM_DESTROY:
        KillTimer(hwnd, TIMER_HEALTH);
        Shell_NotifyIconW(NIM_DELETE, &g_nid);
        stopServers();
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

/* ── entry point ────────────────────────────────────────────────────────── */

static void parseArgs(BOOL *installStartup, BOOL *uninstallStartup, BOOL *stop)
{
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return;
    for (int i = 1; i < argc; i++) {
        if      (!wcscmp(argv[i], L"--no-browser"))        g_openBrowser = FALSE;
        else if (!wcscmp(argv[i], L"--reload"))            g_reload = TRUE;
        else if (!wcscmp(argv[i], L"--prod"))              g_prod = TRUE;
        else if (!wcscmp(argv[i], L"--install-startup"))   *installStartup = TRUE;
        else if (!wcscmp(argv[i], L"--uninstall-startup")) *uninstallStartup = TRUE;
        else if (!wcscmp(argv[i], L"--stop"))              *stop = TRUE;
        else if (!wcscmp(argv[i], L"--backend-port")  && i + 1 < argc) g_backendPort  = _wtoi(argv[++i]);
        else if (!wcscmp(argv[i], L"--frontend-port") && i + 1 < argc) g_frontendPort = _wtoi(argv[++i]);
        else if (!wcscmp(argv[i], L"--root") && i + 1 < argc) {
            wcsncpy(g_rootArg, argv[++i], ARRAYSIZE(g_rootArg) - 1);
            g_rootArg[ARRAYSIZE(g_rootArg) - 1] = 0;
            /* A trailing separator would double up in every path we build. */
            size_t n = wcslen(g_rootArg);
            if (n > 0 && g_rootArg[n - 1] == L'\\') g_rootArg[n - 1] = 0;
        }
        else if (!wcscmp(argv[i], L"--host") && i + 1 < argc) {
            wcsncpy(g_host, argv[++i], ARRAYSIZE(g_host) - 1);
            g_host[ARRAYSIZE(g_host) - 1] = 0;
        }
    }
    LocalFree(argv);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE prev, LPWSTR cmdLine, int show)
{
    (void)prev; (void)cmdLine; (void)show;

    BOOL doInstall = FALSE, doUninstall = FALSE, doStop = FALSE;
    parseArgs(&doInstall, &doUninstall, &doStop);

    if (doInstall) {
        MessageBoxW(NULL, startupInstall()
                    ? L"Bloomberg Terminal will now start with Windows."
                    : L"Could not write the start-up registry entry.",
                    APP_NAME, MB_OK | MB_ICONINFORMATION);
        return 0;
    }
    if (doUninstall) {
        startupUninstall();
        MessageBoxW(NULL, L"Removed from Windows start-up.", APP_NAME,
                    MB_OK | MB_ICONINFORMATION);
        return 0;
    }
    if (doStop) {
        HWND other = FindWindowW(WNDCLASS_NAME, NULL);
        if (other) PostMessageW(other, WM_COMMAND, IDM_QUIT, 0);
        return 0;
    }

    /* Single instance: a second launch just opens the browser. */
    HANDLE mutex = CreateMutexW(NULL, TRUE, MUTEX_NAME);
    if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
        /* Launching it again is how you ask for the window. Except with
         * --no-browser, which is what the log-on task passes: two start-up
         * mechanisms both enabled would otherwise pop a browser at every
         * log-on for no reason. */
        if (g_openBrowser) openFrontend();
        return 0;
    }

    if (!resolveRoot()) {
        MessageBoxW(NULL,
            L"Could not find the Bloomberg Terminal repository.\n\n"
            L"This copy of the launcher is not inside the project folder, and no "
            L"previous run recorded where the project is.\n\n"
            L"Start it once from the repository itself, or pass the path:\n\n"
            L"    BloombergTerminal.exe --root \"D:\\path\\to\\repo\"\n\n"
            L"To launch at log-on, use the tray menu's \"Run at Windows start-up\" "
            L"rather than copying the exe into the Start-up folder.",
            APP_NAME, MB_OK | MB_ICONERROR);
        return 1;
    }
    _snwprintf(g_logDir, MAX_PATH, L"%s\\logs", g_root);
    CreateDirectoryW(g_logDir, NULL);

    /* Job object — children die with us, no orphaned servers. */
    g_job = CreateJobObjectW(NULL, NULL);
    if (g_job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION li;
        ZeroMemory(&li, sizeof(li));
        li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &li, sizeof(li));
    }

    WNDCLASSEXW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = WNDCLASS_NAME;
    RegisterClassExW(&wc);

    /* Message-only window: never visible, never in the taskbar. */
    g_hwnd = CreateWindowExW(0, WNDCLASS_NAME, APP_NAME, 0, 0, 0, 0, 0,
                             HWND_MESSAGE, NULL, hInst, NULL);
    if (!g_hwnd) return 1;

    HICON icon = LoadIconW(hInst, MAKEINTRESOURCEW(IDI_APPICON));
    if (!icon) icon = LoadIconW(NULL, IDI_APPLICATION);

    ZeroMemory(&g_nid, sizeof(g_nid));
    g_nid.cbSize = sizeof(g_nid);
    g_nid.hWnd = g_hwnd;
    g_nid.uID = 1;
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_nid.uCallbackMessage = WM_TRAYICON;
    g_nid.hIcon = icon;
    wcsncpy(g_nid.szTip, APP_NAME L" — starting...", ARRAYSIZE(g_nid.szTip) - 1);
    Shell_NotifyIconW(NIM_ADD, &g_nid);

    startServers();
    SetTimer(g_hwnd, TIMER_HEALTH, 1000, NULL);

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_job) CloseHandle(g_job);
    if (mutex) CloseHandle(mutex);
    return 0;
}
