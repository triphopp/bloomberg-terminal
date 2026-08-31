/**
 * Checks the two gitignored env files against their committed `.example`
 * templates, and against the ports the rest of the repo actually uses.
 *
 * `.env.local` and `backend/.env` never travel with a `git pull`, so every
 * machine keeps whatever it had when it was first set up. A port migration or a
 * renamed key lands in the tracked code on one machine and silently does
 * nothing on the other — the env var wins over the default in the source, so
 * the symptom is "I pulled and nothing changed".
 *
 * Reports:
 *   · env file missing entirely
 *   · keys the template has and the local file lacks
 *   · keys the local file has that the template does not know about
 *   · ports that disagree with package.json / lib/constants.ts / backend/config.py
 *   · leftover 3000 / 8000 values from before the port migration
 *
 * Usage:
 *   node scripts/env-doctor.mjs          report only, exit 0 (runs as predev)
 *   node scripts/env-doctor.mjs --fix    write the fixes back
 *   node scripts/env-doctor.mjs --strict exit 1 when anything is wrong (CI)
 *
 * `--fix` only ever creates a missing file from its template, appends missing
 * keys with the template's default, and rewrites a wrong port inside a value.
 * It never deletes a key: an unknown key may be a secret this checkout needs.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const FIX = argv.includes("--fix");
const STRICT = argv.includes("--strict");

const problems = [];
const fixes = [];
const note = (file, msg, hint) => problems.push({ file, msg, hint });

// ── the ports the repo itself declares ────────────────────────────────────────
// package.json is the source of truth: it is what `npm run dev:all` launches.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const devAll = pkg.scripts?.["dev:all"] ?? "";
const BACKEND_PORT = Number(devAll.match(/BACKEND_PORT:-(\d+)/)?.[1] ?? 9317);
const FRONTEND_PORT = Number(devAll.match(/FRONTEND_PORT:-(\d+)/)?.[1] ?? 9318);

// Ports the migration moved off. A value still carrying one is stale by
// definition — nothing in the repo listens there any more.
const LEGACY = { 8000: BACKEND_PORT, 3000: FRONTEND_PORT };

// ── .env parsing ──────────────────────────────────────────────────────────────
/** `KEY=value` → value. Commented lines are collected separately as "known". */
function parseEnv(text) {
  const active = new Map();
  const commented = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const commentedKey = line.match(/^#\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (commentedKey) {
      commented.add(commentedKey[1]);
      continue;
    }
    if (line.startsWith("#")) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    // Templates carry a trailing `# where to get this key` after the value, and
    // for a blank key that comment is all there is — `KEY=   # https://…`.
    const value = m[2].replace(/(^|\s)#.*$/, "").trim();
    active.set(m[1], value);
  }
  return { active, commented };
}

const portsIn = (value) => [...value.matchAll(/:(\d{4,5})\b/g)].map((m) => Number(m[1]));

// ── one env file ──────────────────────────────────────────────────────────────
function checkEnvFile({ path, examplePath, required = [], expect }) {
  const full = join(ROOT, path);
  const exampleFull = join(ROOT, examplePath);

  if (!existsSync(full)) {
    if (FIX) {
      copyFileSync(exampleFull, full);
      fixes.push(`${path} created from ${examplePath} — fill in the keys it needs`);
      return;
    }
    note(path, "missing", `cp ${examplePath} ${path}`);
    return;
  }

  const example = parseEnv(readFileSync(exampleFull, "utf8"));
  let text = readFileSync(full, "utf8");
  const local = parseEnv(text);
  const known = new Set([...example.active.keys(), ...example.commented]);

  for (const [key, def] of example.active) {
    const have = local.active.has(key) || local.commented.has(key);
    if (required.includes(key) && (!have || !local.active.get(key))) {
      note(path, `${key} is required and ${have ? "empty" : "not set"}`, `see ${examplePath}`);
      continue;
    }
    // A blank key in the template is an optional feature nobody has to enable.
    // Announcing every one of them would bury the findings that matter.
    if (have || !def) continue;
    if (FIX) {
      text += `${text.endsWith("\n") ? "" : "\n"}${key}=${def}\n`;
      fixes.push(`${path}: added ${key}=${def}`);
    } else {
      note(path, `missing key ${key}`, `add ${key}=${def}`);
    }
  }

  for (const key of local.active.keys()) {
    if (!known.has(key)) {
      note(path, `unknown key ${key}`, `not in ${examplePath} — renamed or dropped upstream?`);
    }
  }

  // Port drift, key by key.
  for (const [key, want] of Object.entries(expect)) {
    const value = local.active.get(key);
    if (value === undefined || value === "") continue;
    const found = portsIn(value);
    if (found.length === 0 || found.includes(want)) continue;
    const stale = found.find((p) => LEGACY[p] === want);
    if (stale && FIX) {
      const next = value.replaceAll(`:${stale}`, `:${want}`);
      text = text.replace(`${key}=${value}`, `${key}=${next}`);
      fixes.push(`${path}: ${key} port ${stale} → ${want}`);
    } else {
      note(
        path,
        `${key} points at port ${found.join("/")} — the repo runs on ${want}`,
        stale ? "left over from the 3000/8000 migration" : "intentional? then ignore"
      );
    }
  }

  if (FIX) writeFileSync(full, text);
}

// ── the tracked defaults, so a bad merge is caught too ────────────────────────
function checkSourceDefaults() {
  const constants = readFileSync(join(ROOT, "lib/constants.ts"), "utf8");
  const apiPort = Number(constants.match(/PYTHON_API_URL\s*\?\?\s*"[^"]*:(\d+)"/)?.[1]);
  if (apiPort && apiPort !== BACKEND_PORT) {
    note(
      "lib/constants.ts",
      `PYTHON_API fallback is ${apiPort}, package.json launches ${BACKEND_PORT}`,
      "the two must agree"
    );
  }

  const config = readFileSync(join(ROOT, "backend/config.py"), "utf8");
  const cors = config.match(/CORS_ORIGINS\s*=\s*os\.getenv\(\s*"CORS_ORIGINS",\s*"([^"]*)"/s)?.[1];
  if (cors && !portsIn(cors).includes(FRONTEND_PORT)) {
    note(
      "backend/config.py",
      `CORS default allows ${portsIn(cors).join("/")}, frontend runs on ${FRONTEND_PORT}`,
      "the browser will be blocked by CORS"
    );
  }
}

// ── a shell that overrides everything the files just said ─────────────────────
function checkShellOverrides() {
  for (const [name, want] of [
    ["BACKEND_PORT", BACKEND_PORT],
    ["FRONTEND_PORT", FRONTEND_PORT],
  ]) {
    const v = process.env[name];
    if (v && Number(v) !== want) {
      note(
        "shell",
        `${name}=${v} is exported in this shell — it overrides package.json (${want})`,
        `unset ${name}, or remove it from ~/.zshrc / ~/.bashrc`
      );
    }
  }
  if (process.env.PYTHON_API_URL) {
    // Only the port is worth reporting, and a URL can legitimately carry
    // `user:pass@` — printing the whole value would put a credential on stdout,
    // which for a git hook means the terminal scrollback and any CI log.
    const port = portsIn(process.env.PYTHON_API_URL)[0];
    note(
      "shell",
      `PYTHON_API_URL is exported${port ? ` (port ${port})` : ""} — it wins over .env.local`,
      "unset PYTHON_API_URL"
    );
  }
}

checkEnvFile({
  path: ".env.local",
  examplePath: ".env.local.example",
  required: ["PYTHON_API_URL"],
  expect: { PYTHON_API_URL: BACKEND_PORT },
});
checkEnvFile({
  path: "backend/.env",
  examplePath: "backend/.env.example",
  // Most backend keys unlock one optional view. FRED drives macro, credit and
  // the rate curves — without it the terminal is mostly empty.
  required: ["FRED_API_KEY"],
  expect: { CORS_ORIGINS: FRONTEND_PORT, OLLAMA_URL: 11434 },
});
checkSourceDefaults();
checkShellOverrides();

// ── report ────────────────────────────────────────────────────────────────────
const tag = "[env-doctor]";
if (fixes.length) {
  console.log(`${tag} fixed ${fixes.length}:`);
  for (const f of fixes) console.log(`  ✔ ${f}`);
}

if (problems.length === 0) {
  if (!fixes.length) console.log(`${tag} ok — backend ${BACKEND_PORT}, frontend ${FRONTEND_PORT}`);
  process.exit(0);
}

console.log(
  `${tag} ${problems.length} problem(s) — backend ${BACKEND_PORT}, frontend ${FRONTEND_PORT}`
);
for (const p of problems) {
  console.log(`  ✖ ${p.file}: ${p.msg}`);
  if (p.hint) console.log(`      → ${p.hint}`);
}
console.log(`${tag} run \`npm run doctor:fix\` to apply what can be applied automatically`);

process.exit(STRICT ? 1 : 0);
