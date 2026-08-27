/**
 * Drops `.next` when the set of App Router route files changed since the last
 * dev run.
 *
 * Turbopack's persistent cache remembers which routes exist. A route file added
 * after that cache was written is on disk but absent from the table the dev
 * server restores on a cold start, so it 404s — the file is fine, the cache is
 * stale. Editing any file makes HMR pick it up, which is why it only ever bit
 * the first run after a reboot.
 *
 * Only *structural* changes (a route file added, removed, or renamed) trigger
 * the wipe. Editing a route's contents does not — that would throw away the
 * cache on every start and make dev permanently slow, which is the whole thing
 * the cache exists to prevent.
 *
 * Runs as `predev`. Safe by construction: `.next` is build output, gitignored,
 * always reproducible from source.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const APP_DIR = join(ROOT, "app");
const NEXT_DIR = join(ROOT, ".next");
const STAMP = join(NEXT_DIR, ".route-guard.json");

// The files that *define* a route. A component imported by one of these can
// change freely without altering the route table.
const ROUTE_FILE = /^(route|page|layout|template|default|not-found|error|loading)\.(t|j)sx?$/;

// File-convention metadata (favicon.ico, icon.png, apple-icon.png, …) becomes a
// generated route too, so adding or removing one changes the route table the
// same way a page.tsx does — and goes just as stale in the cache.
const METADATA_FILE =
  /^(favicon\.ico|(icon|apple-icon|opengraph-image|twitter-image)\d*\.(ico|jpg|jpeg|png|svg|gif|tsx?|jsx?)|(robots|sitemap|manifest)\.(txt|xml|json|webmanifest))$/;

function collectRouteFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // app/ missing — nothing to guard
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRouteFiles(full, out);
    } else if (ROUTE_FILE.test(entry.name) || METADATA_FILE.test(entry.name)) {
      out.push(relative(ROOT, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

const routes = collectRouteFiles(APP_DIR).sort();
const hash = createHash("sha1").update(routes.join("\n")).digest("hex");

let previous = null;
try {
  previous = JSON.parse(readFileSync(STAMP, "utf8"));
} catch {
  // No stamp: either a fresh .next or the first run after adding this guard.
  // Record the current shape and let the cache be — wiping here would punish
  // every developer's first run for nothing.
}

if (previous && previous.hash !== hash) {
  const added = routes.filter((r) => !previous.routes.includes(r));
  const removed = (previous.routes ?? []).filter((r) => !routes.includes(r));
  console.log(
    `[next-cache-guard] route table changed (+${added.length} / -${removed.length}) — clearing .next`
  );
  for (const r of [...added.slice(0, 5), ...removed.slice(0, 5)]) console.log(`  · ${r}`);
  rmSync(NEXT_DIR, { recursive: true, force: true });
}

mkdirSync(NEXT_DIR, { recursive: true });
writeFileSync(STAMP, JSON.stringify({ hash, routes }, null, 1));
