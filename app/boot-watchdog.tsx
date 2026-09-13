/**
 * Boot watchdog — an inline script, on purpose.
 *
 * `app/page.tsx` loads the terminal through `dynamic(ssr:false)`, so the server
 * still ships the loading fallback as static HTML. When the client bundle never
 * loads or never executes (a dev chunk that 404s after a rebuild, a request that
 * stalls, a script error before hydration), that static "BLOOMBERG" markup is
 * all that is left on screen: React never mounts, so no React-side timer can
 * fire and no error boundary is reached. The page just sits there until someone
 * hits refresh by hand.
 *
 * This script runs from the HTML itself, before and independent of every chunk,
 * so it is still alive in exactly the case the React watchdog is not. It reloads
 * once — the same refresh the user was doing — and then stands down so a page
 * that is genuinely broken cannot reload-loop.
 *
 * It reloads only for a page that has STOPPED, never for one that is merely
 * slow: see PROGRESS_GRACE_MS below.
 *
 * `window.__BT_MOUNTED__` is set by the terminal on mount (see
 * `components/bloomberg/layout/bloomberg-terminal.tsx`).
 */

const RELOAD_AFTER_MS = 12_000;
const RETRY_WINDOW_MS = 60_000;
// A slow client is not a stalled one. A phone on wifi pulling the unminified
// dev bundle needs far longer than a desktop on loopback: measured over the LAN,
// this page is 161 resources and 65 scripts, done at ~2.7s on a laptop — an
// iPhone was 19 resources in at the 12s mark and still climbing. Reloading there
// threw away everything it had fetched and restarted the same race, so the
// terminal could never finish booting no matter how many times it tried. Every
// beacon from that phone said "timeout" and not one said ChunkLoadError: nothing
// was broken, it simply had not arrived yet. So before reloading, check whether
// resources are still landing, and if they are, give it another window.
const PROGRESS_GRACE_MS = 8_000;
const MAX_GRACE_ROUNDS = 8; // ~76s of genuine progress before giving up

const script = `
(function () {
  var KEY = "bloomberg_boot_retry_at";
  var reloaded = false;
  function diag(why) {
    try {
      var nav = performance.getEntriesByType("navigation")[0] || {};
      var scripts = performance.getEntriesByType("resource")
        .filter(function (r) { return r.initiatorType === "script" || r.name.indexOf(".js") > -1; })
        .map(function (r) { return { u: r.name.split("/").pop(), d: Math.round(r.duration), size: r.transferSize }; });
      var pending = performance.getEntriesByType("resource").length;
      navigator.sendBeacon(
        "/api/boot-diag",
        JSON.stringify({
          why: why,
          href: location.href,
          prerendered: nav.activationStart > 0,
          activationStart: nav.activationStart,
          visibility: document.visibilityState,
          readyState: document.readyState,
          sinceNav: Math.round(performance.now()),
          resources: pending,
          slowScripts: scripts.sort(function (a, b) { return b.d - a.d; }).slice(0, 8),
          ua: navigator.userAgent,
        })
      );
    } catch (e) {}
  }

  function retry(why) {
    if (reloaded || window.__BT_MOUNTED__ || document.prerendering) return;
    diag(why);
    var last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch (e) {}
    if (Date.now() - last < ${RETRY_WINDOW_MS}) {
      console.error("[boot] terminal did not mount (" + why + ") — already retried, not reloading again");
      var el = document.getElementById("boot-stalled");
      if (el) el.hidden = false;
      return;
    }
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch (e) {}
    reloaded = true;
    console.warn("[boot] terminal did not mount (" + why + ") — reloading");
    window.location.reload();
  }
  function resourceCount() {
    try { return performance.getEntriesByType("resource").length; } catch (e) { return 0; }
  }
  // Reload only when the page has stopped making progress. While the resource
  // count is still climbing the bundle is downloading, not stuck.
  function watch(seen, rounds) {
    var now = resourceCount();
    if (window.__BT_MOUNTED__) return;
    if (now > seen && rounds < ${MAX_GRACE_ROUNDS}) {
      console.info("[boot] still loading (" + now + " resources) — waiting");
      setTimeout(function () { watch(now, rounds + 1); }, ${PROGRESS_GRACE_MS});
      return;
    }
    retry(now > seen ? "slow" : "timeout");
  }
  function arm() {
    setTimeout(function () { watch(resourceCount(), 0); }, ${RELOAD_AFTER_MS});
  }
  // A prerendered document (Chrome starts one while you type the URL in the
  // omnibox) is not on screen yet and may sit half-loaded for a long time —
  // that is not a stall, and reloading there would throw the prerender away.
  // Start counting from activation instead.
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", arm, { once: true });
  } else {
    arm();
  }
  window.addEventListener("error", function (e) {
    var name = e && e.error && e.error.name;
    var msg = (e && e.message) || "";
    if (name === "ChunkLoadError" || msg.indexOf("Loading chunk") > -1 || msg.indexOf("dynamically imported module") > -1) {
      retry(name || msg);
    }
  });
})();
`;

export function BootWatchdog() {
  return (
    <>
      {/* A raw tag, not next/script: it must sit in the server HTML and run
          from there (the client bundle is exactly what may be missing), and
          `beforeInteractive` would additionally hold up hydration — measured at
          ~150ms of extra time on the boot screen for a script this small. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static string, no user input */}
      <script dangerouslySetInnerHTML={{ __html: script }} />
      <div
        id="boot-stalled"
        hidden
        style={{
          position: "fixed",
          bottom: 12,
          left: 0,
          right: 0,
          textAlign: "center",
          zIndex: 9999,
          color: "#FF4444",
          font: "10px ui-monospace, monospace",
        }}
      >
        TERMINAL BUNDLE DID NOT LOAD — hard reload (Ctrl+Shift+R), then check the dev-server output
      </div>
    </>
  );
}
