#!/usr/bin/env python3
"""
thesis_to_html.py — Convert Obsidian investment thesis .md → Bloomberg-themed HTML

Usage:
    python tools/thesis_to_html.py
    python tools/thesis_to_html.py --input "G:/My Drive/Obsidian Vault/wiki/theses"
    python tools/thesis_to_html.py --input thesis.md --output output.html
    python tools/thesis_to_html.py --input "wiki/theses" --output "wiki/theses/html"

Requirements: pip install pyyaml
"""

import argparse
import os
import re
import sys
from datetime import datetime
from pathlib import Path

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML required. Run: pip install pyyaml")
    sys.exit(1)

# ── HTML Template ─────────────────────────────────────────────────────────────

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
<style>
/* ── Bloomberg Dark Theme ───────────────────────────────── */
:root {{
  --bg:           #0a0a0f;
  --surface:      #11111a;
  --surface2:     #1a1a28;
  --border:       #2a2a3a;
  --accent:       #ff6600;
  --accent-dim:   rgba(255,102,0,0.12);
  --text:         #e8e8e8;
  --text-dim:     #8888a0;
  --green:        #4ade80;
  --green-dim:    rgba(74,222,128,0.12);
  --red:          #f87171;
  --red-dim:      rgba(248,113,113,0.12);
  --yellow:       #fbbf24;
  --yellow-dim:   rgba(251,191,36,0.12);
}}
[data-theme="light"] {{
  --bg:           #f4f4f0;
  --surface:      #ffffff;
  --surface2:     #f0f0ea;
  --border:       #d0d0c8;
  --accent:       #d45000;
  --accent-dim:   rgba(212,80,0,0.08);
  --text:         #1a1a2e;
  --text-dim:     #666680;
  --green:        #16a34a;
  --green-dim:    rgba(22,163,74,0.08);
  --red:          #dc2626;
  --red-dim:      rgba(220,38,38,0.08);
  --yellow:       #d97706;
  --yellow-dim:   rgba(217,119,6,0.08);
}}

*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
html {{ font-size: 15px; scroll-behavior: smooth; }}
body {{
  font-family: 'Sarabun', sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.7;
  display: flex;
  min-height: 100vh;
}}

/* ── Layout ──────────────────────────────────────────── */
nav#toc {{
  width: 240px;
  min-width: 240px;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 1.5rem 1rem;
  font-size: 0.8rem;
}}
nav#toc h2 {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.65rem;
  color: var(--accent);
  letter-spacing: 0.15em;
  text-transform: uppercase;
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}}
nav#toc ul {{ list-style: none; }}
nav#toc li {{ margin-bottom: 0.25rem; }}
nav#toc a {{
  color: var(--text-dim);
  text-decoration: none;
  display: block;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  border-left: 2px solid transparent;
  transition: all 0.15s;
  font-size: 0.78rem;
  line-height: 1.4;
}}
nav#toc a:hover,
nav#toc a.active {{
  color: var(--accent);
  border-left-color: var(--accent);
  background: var(--accent-dim);
}}

main {{
  flex: 1;
  max-width: 860px;
  margin: 0 auto;
  padding: 2rem 2.5rem;
}}

/* ── Theme toggle ────────────────────────────────────── */
#theme-btn {{
  position: fixed;
  top: 1rem;
  right: 1.25rem;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 0.3rem 0.75rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.05em;
  z-index: 100;
  transition: all 0.15s;
}}
#theme-btn:hover {{ color: var(--accent); border-color: var(--accent); }}

/* ── Header ──────────────────────────────────────────── */
.doc-header {{
  border-bottom: 2px solid var(--accent);
  padding-bottom: 1.5rem;
  margin-bottom: 2rem;
}}
.doc-header .symbol {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 2.2rem;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: -0.02em;
}}
.doc-header .doc-title {{
  font-size: 1.1rem;
  color: var(--text-dim);
  margin-top: 0.25rem;
}}
.meta-badges {{
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.75rem;
}}
.badge {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.65rem;
  padding: 0.2rem 0.6rem;
  border-radius: 3px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}}
.badge.status-active {{ color: var(--green); border-color: rgba(74,222,128,0.3); background: var(--green-dim); }}
.badge.confidence {{ color: var(--yellow); border-color: rgba(251,191,36,0.3); background: var(--yellow-dim); }}
.badge.tag {{ color: var(--text-dim); }}

/* ── Section Headings ────────────────────────────────── */
h2.section-title {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--accent);
  margin-top: 2.5rem;
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}}
h3 {{
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
  margin: 1.25rem 0 0.5rem;
}}

/* ── Claim block ─────────────────────────────────────── */
.claim-block {{
  background: var(--accent-dim);
  border-left: 3px solid var(--accent);
  padding: 1rem 1.25rem;
  border-radius: 0 6px 6px 0;
  font-size: 0.95rem;
  color: var(--text);
  line-height: 1.75;
  margin-bottom: 1rem;
}}

/* ── Condition Killer cards ──────────────────────────── */
.ko-grid {{ display: flex; flex-direction: column; gap: 0.75rem; }}
.ko-card {{
  background: var(--red-dim);
  border: 1px solid rgba(248,113,113,0.25);
  border-radius: 6px;
  overflow: hidden;
}}
.ko-header {{
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  cursor: pointer;
  user-select: none;
}}
.ko-id {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--red);
  background: rgba(248,113,113,0.15);
  border: 1px solid rgba(248,113,113,0.3);
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  white-space: nowrap;
  margin-top: 0.1rem;
  flex-shrink: 0;
}}
.ko-title {{
  flex: 1;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
}}
.ko-prob {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.65rem;
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  background: rgba(248,113,113,0.15);
  color: #fca5a5;
  white-space: nowrap;
  flex-shrink: 0;
}}
.ko-body {{
  display: none;
  padding: 0 1rem 1rem 1rem;
  border-top: 1px solid rgba(248,113,113,0.15);
}}
.ko-body.open {{ display: block; }}
.ko-monitor {{
  background: rgba(248,113,113,0.1);
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  font-size: 0.82rem;
  color: #fca5a5;
  margin: 0.75rem 0;
}}
.ko-monitor strong {{ color: var(--red); }}

/* ── Catalyst cards ──────────────────────────────────── */
.catalyst-list {{ display: flex; flex-direction: column; gap: 0.5rem; }}
.catalyst-item {{
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.6rem 0.85rem;
  background: var(--green-dim);
  border: 1px solid rgba(74,222,128,0.2);
  border-radius: 6px;
  font-size: 0.88rem;
  color: #86efac;
  line-height: 1.5;
}}
.catalyst-icon {{ color: var(--green); margin-top: 0.1rem; flex-shrink: 0; }}

/* ── General content ─────────────────────────────────── */
p {{ margin-bottom: 0.75rem; color: var(--text-dim); font-size: 0.9rem; }}
strong {{ color: var(--text); font-weight: 600; }}
em {{ color: var(--text-dim); font-style: italic; }}
ul, ol {{ margin-left: 1.25rem; margin-bottom: 0.75rem; color: var(--text-dim); font-size: 0.9rem; }}
li {{ margin-bottom: 0.3rem; }}
code {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8em;
  background: var(--surface2);
  padding: 0.1em 0.35em;
  border-radius: 3px;
  color: var(--accent);
}}

/* ── Tables ──────────────────────────────────────────── */
table {{
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 1rem;
  font-size: 0.88rem;
}}
th {{
  background: var(--surface2);
  color: var(--accent);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.6rem 0.85rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
}}
td {{
  padding: 0.55rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
}}
tr:last-child td {{ border-bottom: none; }}
tr:hover td {{ background: var(--surface2); color: var(--text); }}

/* ── Print ───────────────────────────────────────────── */
@media print {{
  nav#toc, #theme-btn {{ display: none; }}
  body {{ display: block; background: #fff; color: #000; }}
  main {{ max-width: 100%; padding: 1rem; }}
  h2.section-title {{ color: #333; border-color: #ccc; }}
  .claim-block {{ background: #f5f5f5; border-color: #999; color: #111; }}
  .ko-card {{ background: #fff8f8; border-color: #ffcccc; }}
  .ko-body {{ display: block !important; }}
  .catalyst-item {{ background: #f0fff4; border-color: #9ae6b4; color: #276749; }}
}}

/* ── Mobile ──────────────────────────────────────────── */
@media (max-width: 768px) {{
  nav#toc {{ display: none; }}
  main {{ padding: 1rem 1.25rem; }}
  #theme-btn {{ top: 0.5rem; right: 0.75rem; }}
}}
</style>
</head>
<body>

<button id="theme-btn" onclick="toggleTheme()" title="Toggle dark/light">◐ THEME</button>

<nav id="toc">
  <h2>⬛ Contents</h2>
  <ul>{toc_items}</ul>
</nav>

<main>
  <div class="doc-header">
    <div class="symbol">{symbol}</div>
    <div class="doc-title">{title}</div>
    <div class="meta-badges">
      <span class="badge status-active">{status}</span>
      <span class="badge confidence">{confidence}</span>
      {tag_badges}
    </div>
    <div style="margin-top:0.75rem; font-size:0.75rem; color:var(--text-dim); font-family:'JetBrains Mono',monospace;">
      Last updated: {last_updated} &nbsp;·&nbsp; Generated: {generated}
    </div>
  </div>

  {sections_html}
</main>

<script>
// ── Dark/Light toggle
const saved = localStorage.getItem('thesis-theme') || 'dark';
document.documentElement.dataset.theme = saved;
function toggleTheme() {{
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('thesis-theme', next);
}}

// ── KO expand/collapse
document.querySelectorAll('.ko-header').forEach(h => {{
  h.addEventListener('click', () => {{
    const body = h.nextElementSibling;
    if (body) body.classList.toggle('open');
  }});
  // Open first KO by default
  if (h.closest('.ko-card:first-child')) {{
    const body = h.nextElementSibling;
    if (body) body.classList.add('open');
  }}
}});

// ── Scroll spy for ToC
const sections = document.querySelectorAll('section[id]');
const links = document.querySelectorAll('nav#toc a');
const observer = new IntersectionObserver((entries) => {{
  entries.forEach(e => {{
    if (e.isIntersecting) {{
      links.forEach(l => l.classList.remove('active'));
      const active = document.querySelector(`nav#toc a[href="#${{e.target.id}}"]`);
      if (active) active.classList.add('active');
    }}
  }});
}}, {{ rootMargin: '-20% 0px -70% 0px' }});
sections.forEach(s => observer.observe(s));
</script>
</body>
</html>"""

# ── Parser ────────────────────────────────────────────────────────────────────

def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    lines = text.split("\n")
    try:
        end = next(i for i, ln in enumerate(lines[1:], 1) if ln.strip() == "---")
    except StopIteration:
        return {}, text
    fm_raw = "\n".join(lines[1:end])
    body = "\n".join(lines[end + 1:]).lstrip("\n")
    try:
        fm = yaml.safe_load(fm_raw) or {}
    except Exception:
        fm = {}
    return fm if isinstance(fm, dict) else {}, body


def parse_sections(body: str) -> dict[str, str]:
    sections: dict[str, str] = {}
    current_key = "preamble"
    current_lines: list[str] = []
    for line in body.split("\n"):
        if line.startswith("## "):
            if current_lines:
                sections[current_key] = "\n".join(current_lines).strip()
            title = line[3:].strip().lower()
            key_map = {
                "claim": "claim",
                "condition": "condition_killers",
                "killer": "condition_killers",
                "catalyst": "catalysts",
                "valuation": "valuation",
                "compelling": "compelling",
                "น่าสนใจ": "compelling",
                "supporting": "supporting_evidence",
                "evidence": "supporting_evidence",
                "challenge": "challenges",
                "key risk": "key_risks",
            }
            key = next((v for k, v in key_map.items() if k in title), re.sub(r"[^a-z0-9_]", "_", title)[:40])
            current_key = key
            current_lines = []
        else:
            current_lines.append(line)
    if current_lines:
        sections[current_key] = "\n".join(current_lines).strip()
    return sections


def parse_condition_killers(text: str) -> list[dict]:
    kos = []
    blocks = re.split(r"\n(?=### (?:KO #\d+|❌ \d+\.|❌ \w+\.))", text)
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        m = re.match(r"### (?:KO #(\d+)[:\s]+|❌ (\d+)\.\s+|❌ (\w+)\.\s*)(.+)", block)
        if not m:
            continue
        ko_id = m.group(1) or m.group(2) or m.group(3) or "?"
        title = m.group(4).strip()
        content = block[m.end():].strip()
        prob_m = re.search(r"\*\*ความน่าจะเป็น[^*]*\*\*[:\s]*(.+?)(?:\n|$)", content)
        probability = prob_m.group(1).strip() if prob_m else ""
        monitor_m = re.search(r"\*\*(?:เงื่อนไขที่ต้องสังเกต|Monitor)[^*]*\*\*[:\s]*(.+?)(?:\n\n|$)", content, re.DOTALL)
        monitor = monitor_m.group(1).strip() if monitor_m else ""
        kos.append({"id": ko_id, "title": title, "content": content, "probability": probability, "monitor": monitor})
    return kos


# ── Renderers ─────────────────────────────────────────────────────────────────

def md_inline(text: str) -> str:
    """Convert inline markdown to HTML."""
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)          # wiki links
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    return text


def render_section_body(text: str) -> str:
    """Convert markdown section body to HTML."""
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("### "):
            out.append(f"<h3>{md_inline(line[4:])}</h3>")
        elif line.startswith("| ") and i + 1 < len(lines) and lines[i + 1].startswith("|---"):
            headers = [c.strip() for c in line.split("|") if c.strip()]
            i += 2
            rows: list[list[str]] = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].split("|") if c.strip()])
                i += 1
            ths = "".join(f"<th>{md_inline(h)}</th>" for h in headers)
            trs = "".join(
                "<tr>" + "".join(f"<td>{md_inline(c)}</td>" for c in row) + "</tr>"
                for row in rows
            )
            out.append(f"<table><thead><tr>{ths}</tr></thead><tbody>{trs}</tbody></table>")
            continue
        elif line.startswith("- ") or line.startswith("* "):
            items: list[str] = []
            while i < len(lines) and (lines[i].startswith("- ") or lines[i].startswith("* ")):
                items.append(f"<li>{md_inline(lines[i][2:])}</li>")
                i += 1
            out.append(f"<ul>{''.join(items)}</ul>")
            continue
        elif re.match(r"^\d+\. ", line):
            items = []
            num_pattern = re.compile(r"^\d+\. ")
            while i < len(lines) and num_pattern.match(lines[i]):
                item_text = num_pattern.sub("", lines[i])
                items.append(f"<li>{md_inline(item_text)}</li>")
                i += 1
            out.append(f"<ol>{''.join(items)}</ol>")
            continue
        elif line.strip():
            out.append(f"<p>{md_inline(line)}</p>")
        i += 1
    return "\n".join(out)


def render_ko_cards(kos: list[dict]) -> str:
    cards = []
    for ko in kos:
        monitor_html = (
            f'<div class="ko-monitor"><strong>Monitor:</strong> {md_inline(ko["monitor"])}</div>'
            if ko["monitor"] else ""
        )
        prob_html = f'<span class="ko-prob">{ko["probability"]}</span>' if ko["probability"] else ""
        body_html = render_section_body(ko["content"])
        cards.append(f"""
<div class="ko-card">
  <div class="ko-header">
    <span class="ko-id">KO #{ko['id']}</span>
    <span class="ko-title">{md_inline(ko['title'])}</span>
    {prob_html}
  </div>
  <div class="ko-body">
    {monitor_html}
    {body_html}
  </div>
</div>""")
    return '<div class="ko-grid">' + "\n".join(cards) + "</div>"


def render_catalysts(text: str) -> str:
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    items = []
    for line in lines:
        if line.startswith(("- ", "* ")) or re.match(r"^\d+\. ", line):
            clean = re.sub(r"^[-*\d]+\.?\s*", "", line)
            clean = re.sub(r"^\*\*(.+?)\*\*", r"\1", clean)
            items.append(
                f'<div class="catalyst-item"><span class="catalyst-icon">✅</span>{md_inline(clean)}</div>'
            )
    if not items:
        return render_section_body(text)
    return '<div class="catalyst-list">' + "\n".join(items) + "</div>"


# ── Main converter ────────────────────────────────────────────────────────────

def convert_thesis(md_path: Path, output_path: Path) -> None:
    text = md_path.read_text(encoding="utf-8", errors="replace")
    fm, body = parse_frontmatter(text)
    sections = parse_sections(body)
    kos = parse_condition_killers(sections.get("condition_killers", ""))

    symbol = md_path.stem.split("-")[0].upper()
    title = fm.get("title") or md_path.stem
    status = fm.get("status") or "unknown"
    confidence = fm.get("confidence") or ""
    last_updated = str(fm.get("last_updated") or "")
    tags: list[str] = fm.get("tags") or []
    generated = datetime.now().strftime("%Y-%m-%d")

    # ── Build ToC
    section_order = [
        ("claim",             "📌 The Claim"),
        ("compelling",        "💡 Why Compelling"),
        ("condition_killers", "❌ Condition Killers"),
        ("catalysts",         "✅ Catalysts"),
        ("key_risks",         "⚠️ Key Risks"),
        ("valuation",         "📊 Valuation"),
        ("supporting_evidence","📚 Supporting Evidence"),
    ]
    toc_items = []
    sections_html_parts = []
    for key, label in section_order:
        if key not in sections:
            continue
        anchor = key.replace("_", "-")
        toc_items.append(f'<li><a href="#{anchor}">{label}</a></li>')

        # Render section body
        if key == "claim":
            content_html = f'<div class="claim-block">{md_inline(sections[key])}</div>'
        elif key == "condition_killers":
            content_html = render_ko_cards(kos) if kos else render_section_body(sections[key])
        elif key == "catalysts":
            content_html = render_catalysts(sections[key])
        else:
            content_html = render_section_body(sections[key])

        sections_html_parts.append(f"""
<section id="{anchor}">
  <h2 class="section-title">{label}</h2>
  {content_html}
</section>""")

    tag_badges = " ".join(f'<span class="badge tag">{t}</span>' for t in tags if t != symbol.lower())

    html = HTML_TEMPLATE.format(
        title=title,
        symbol=symbol,
        status=status,
        confidence=confidence,
        last_updated=last_updated,
        generated=generated,
        tag_badges=tag_badges,
        toc_items="\n".join(toc_items),
        sections_html="\n".join(sections_html_parts),
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding="utf-8")
    print(f"  OK  {md_path.name}  ->  {output_path}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Convert investment thesis .md files to Bloomberg-themed HTML",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--input", "-i",
        default="G:/My Drive/Obsidian Vault/wiki/theses",
        help="Input .md file or directory (default: %(default)s)",
    )
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Output .html file or directory (default: <input_dir>/html/)",
    )
    args = parser.parse_args()

    input_path = Path(args.input)

    # Single file
    if input_path.is_file():
        output_path = Path(args.output) if args.output else input_path.with_suffix(".html")
        print(f"\nConverting: {input_path}")
        convert_thesis(input_path, output_path)
        print(f"\nDone — open {output_path}")
        return

    # Directory
    if not input_path.is_dir():
        print(f"ERROR: Not found: {input_path}")
        sys.exit(1)

    output_dir = Path(args.output) if args.output else input_path / "html"
    md_files = sorted(input_path.glob("*.md"))
    if not md_files:
        print(f"No .md files found in {input_path}")
        sys.exit(0)

    print(f"\nConverting {len(md_files)} thesis file(s):")
    print(f"  Input:  {input_path}")
    print(f"  Output: {output_dir}\n")

    for md_file in md_files:
        out_file = output_dir / md_file.with_suffix(".html").name
        convert_thesis(md_file, out_file)

    print(f"\nDone -- {len(md_files)} files written to {output_dir}")
    print(f"  Open any .html file in your browser to view.")


if __name__ == "__main__":
    main()
