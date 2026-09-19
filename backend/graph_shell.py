"""
The document shell that /api/v2/graphs/<slug>/render wraps an analysis page in.

An agent writes the CONTENT of a page — headings, tables, inline SVG, prose.
What a page should LOOK like is not its business: typography, the measure of a
text column, the section tabs along the top and the Thai typeface are the
book's, and they have to be the same on every page including the ones written
before this file existed. So the shell is applied at render time rather than
baked into the stored HTML:

  stored index.html      = what the agent wrote, untouched, diffable in git
  GET .../render         = shell + that content
  GET .../render?shell=0 = the raw file, for debugging what an agent produced

Three constraints shape the implementation:

1. **CSP allows `font-src data:` only** (see RENDER_CSP in routers/graphs.py).
   Google Fonts, `<link rel=stylesheet>` and any other off-box request are
   blocked by design, because the page is model-written. The Thai face is
   therefore embedded as a data: URI from `research/graphs/_assets/`, with
   `local()` first so a machine that already has it skips the payload.

2. **The page may carry its own <style>.** The shell's CSS is emitted BEFORE
   the content, so a page that styles itself still wins — the shell is a floor,
   not a ceiling.

3. **The content may be a whole document.** Pages written before the shell are
   complete HTML files; `_inner()` unwraps them so we never nest <html>.
"""
from __future__ import annotations

import base64
import re
from functools import lru_cache
from pathlib import Path

from config import GRAPHS_DIR

ASSETS_DIR = GRAPHS_DIR / "_assets"

# The body face. Laksaman is a Thai serif with a Latin companion, so one family
# carries both scripts at the same weight — mixing a Latin serif with a Thai
# sans is what makes these pages look assembled rather than typeset.
FONT_FILES = {
    400: "laksaman-regular.woff2",
    700: "laksaman-bold.woff2",
}


@lru_cache(maxsize=1)
def _font_face_css() -> str:
    """@font-face rules, with the woff2 inlined when the file is present.

    `local()` comes first: a machine with Laksaman installed renders instantly
    and never pays for the base64. When no file is bundled the rule still ships
    the local() source, so the page is correct there too and merely falls back
    to the stack elsewhere.
    """
    rules = []
    for weight, name in FONT_FILES.items():
        path = ASSETS_DIR / name
        src = 'local("Laksaman"), local("Laksaman-Regular")'
        if path.exists():
            b64 = base64.b64encode(path.read_bytes()).decode("ascii")
            src += f', url(data:font/woff2;base64,{b64}) format("woff2")'
        rules.append(
            "@font-face{font-family:'Laksaman';font-style:normal;"
            f"font-weight:{weight};font-display:swap;src:{src};}}"
        )
    return "".join(rules)


def font_is_bundled() -> bool:
    """True when at least one weight ships as a data: URI."""
    return any((ASSETS_DIR / n).exists() for n in FONT_FILES.values())


SHELL_CSS = """
:root{
  --paper:#FBFAF7; --ink:#14171A; --ink-2:#39424A; --muted:#6B7680;
  --hair:#DCD8CF; --rule:#C9C3B6; --accent:#8C2F1E; --mark:#F3EDE1;
  --serif:'Laksaman','Noto Serif Thai','Sarabun',Georgia,'Times New Roman',serif;
  --mono:ui-monospace,'Cascadia Mono','SF Mono',Menlo,Consolas,monospace;
  --measure:74ch;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --paper:#0D0F11; --ink:#E9E6DF; --ink-2:#BDB8AF; --muted:#8A8F95;
    --hair:#262A2E; --rule:#333A40; --accent:#E0836B; --mark:#1B1F22;
  }
}
:root[data-theme="dark"]{
  --paper:#0D0F11; --ink:#E9E6DF; --ink-2:#BDB8AF; --muted:#8A8F95;
  --hair:#262A2E; --rule:#333A40; --accent:#E0836B; --mark:#1B1F22;
}
*{box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font-family:var(--serif); font-size:17px; line-height:1.78;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}

/* masthead */
.gs-head{border-bottom:1px solid var(--rule); padding:26px 20px 14px;}
.gs-head .in{max-width:var(--measure); margin:0 auto;}
.gs-kicker{font-family:var(--mono); font-size:11px; letter-spacing:.16em;
  text-transform:uppercase; color:var(--muted);}
.gs-title{font-size:clamp(25px,3.6vw,36px); line-height:1.22; font-weight:700;
  margin:6px 0 8px; letter-spacing:-.01em;}
.gs-dek{color:var(--ink-2); font-size:17px; margin:0 0 10px;}
.gs-stamp{display:flex; flex-wrap:wrap; gap:4px 16px; font-family:var(--mono);
  font-size:11.5px; color:var(--muted);}

/* section tabs — sticky, built from the page's own h2/h3 */
.gs-tabs{position:sticky; top:0; z-index:20; background:var(--paper);
  border-bottom:1px solid var(--hair); overflow-x:auto; scrollbar-width:thin;}
.gs-tabs ul{display:flex; gap:2px; list-style:none; margin:0 auto; padding:0 16px;
  max-width:var(--measure);}
.gs-tabs a{display:block; white-space:nowrap; padding:9px 11px; text-decoration:none;
  font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; text-transform:uppercase;
  color:var(--muted); border-bottom:2px solid transparent;}
.gs-tabs a:hover{color:var(--ink);}
.gs-tabs a.on{color:var(--accent); border-bottom-color:var(--accent);}
.gs-tabs a.sub{text-transform:none; letter-spacing:0; font-size:11px; opacity:.85;}

/* body */
.gs-body{max-width:var(--measure); margin:0 auto; padding:26px 20px 90px;}
.gs-body > *{max-width:100%;}
.gs-body h1{font-size:clamp(23px,3.2vw,31px); line-height:1.25; margin:34px 0 10px;}
.gs-body h2{font-size:clamp(20px,2.6vw,25px); line-height:1.3; margin:44px 0 10px;
  padding-bottom:6px; border-bottom:1px solid var(--hair); scroll-margin-top:56px;}
.gs-body h3{font-size:19px; margin:28px 0 8px; scroll-margin-top:56px;}
.gs-body h4{font-size:16.5px; margin:20px 0 6px; color:var(--ink-2);}
.gs-body p{margin:0 0 14px;}
.gs-body ul,.gs-body ol{margin:0 0 14px; padding-left:24px;}
.gs-body li{margin:0 0 5px;}
.gs-body a{color:var(--accent); text-underline-offset:2px;}
.gs-body blockquote{margin:0 0 16px; padding:2px 0 2px 16px;
  border-left:3px solid var(--rule); color:var(--ink-2);}
.gs-body code,.gs-body .mono,.gs-body .num{font-family:var(--mono);
  font-variant-numeric:tabular-nums;}
.gs-body code{font-size:.88em; background:var(--mark); padding:1px 4px;}
.gs-body pre{font-family:var(--mono); font-size:13px; line-height:1.55;
  background:var(--mark); padding:12px 14px; overflow-x:auto; margin:0 0 16px;}
.gs-body hr{border:0; border-top:1px solid var(--hair); margin:28px 0;}
.gs-body table{border-collapse:collapse; width:100%; font-size:14.5px;
  font-variant-numeric:tabular-nums; margin:0 0 6px;}
.gs-body thead th{font-family:var(--mono); font-size:11px; letter-spacing:.06em;
  text-transform:uppercase; color:var(--muted); font-weight:600; text-align:right;
  border-bottom:1.5px solid var(--rule); padding:7px 10px;}
.gs-body thead th:first-child{text-align:left;}
.gs-body td{padding:7px 10px; text-align:right; border-bottom:1px solid var(--hair);}
.gs-body td:first-child{text-align:left;}
.gs-body svg{max-width:100%; height:auto;}

/* figures, side notes, sources — the classes the template documents */
.gs-body .fig{margin:0 0 22px;}
.gs-body .fig figcaption,.gs-body .cap{font-size:13.5px; color:var(--muted);
  line-height:1.55; margin-top:7px;}
.gs-body .tablebox{overflow-x:auto; margin:0 0 22px;}
.gs-body .lede{font-size:18.5px; color:var(--ink-2); margin:0 0 20px;}
.gs-body .note{background:var(--mark); border-left:3px solid var(--rule);
  padding:12px 14px; margin:0 0 18px; font-size:15.5px;}
.gs-body .src{font-size:13px; color:var(--muted); font-family:var(--mono);
  line-height:1.6;}
.gs-body .src li{margin-bottom:3px;}

@media print{
  .gs-tabs{display:none;}
  body{background:#fff; color:#000; font-size:11.5pt;}
  .gs-body{max-width:none;}
}
@media (max-width:640px){
  body{font-size:16px;}
  .gs-body{padding:20px 16px 70px;}
}
"""

# Built at runtime rather than server-side so it also works on a page opened
# straight off disk with no backend. Reads the DOM the agent wrote — nothing
# else — and IntersectionObserver keeps the current section lit while scrolling.
SHELL_JS = """
(function(){
  var body=document.getElementById('gs-body'), bar=document.getElementById('gs-tabs');
  if(!body||!bar) return;

  // Pages written before the shell paint their own background, and a masthead
  // in the shell's colours over a page in its own reads as two documents
  // stapled together. So: if the page overrode the body colours, the chrome
  // adopts them. A probe answers "did it?" without guessing at colour formats.
  var probe=document.createElement('div');
  probe.style.cssText='background:var(--paper);color:var(--ink);position:absolute;visibility:hidden';
  document.body.appendChild(probe);
  var ps=getComputedStyle(probe), bs=getComputedStyle(document.body);
  if(bs.backgroundColor!==ps.backgroundColor && bs.backgroundColor!=='rgba(0, 0, 0, 0)'){
    var r=document.documentElement.style, ink=bs.color;
    r.setProperty('--paper', bs.backgroundColor);
    r.setProperty('--ink', ink);
    r.setProperty('--muted','color-mix(in srgb, '+ink+' 58%, transparent)');
    r.setProperty('--ink-2','color-mix(in srgb, '+ink+' 78%, transparent)');
    r.setProperty('--hair','color-mix(in srgb, '+ink+' 18%, transparent)');
    r.setProperty('--rule','color-mix(in srgb, '+ink+' 34%, transparent)');
    r.setProperty('--mark','color-mix(in srgb, '+ink+' 8%, transparent)');
  }
  probe.remove();

  var heads=[].slice.call(body.querySelectorAll('h2,h3'));
  if(heads.length<2){ bar.remove(); return; }
  var used={};
  var ul=document.createElement('ul');
  heads.forEach(function(h,i){
    if(!h.id){
      var base=(h.textContent||'').trim().toLowerCase()
        .replace(/[^\\p{L}\\p{N}]+/gu,'-').replace(/^-|-$/g,'').slice(0,50) || ('s'+i);
      if(used[base]) base=base+'-'+(++used[base]); else used[base]=1;
      h.id=base;
    }
    var li=document.createElement('li'), a=document.createElement('a');
    a.href='#'+h.id; a.textContent=(h.textContent||'').trim();
    if(h.tagName==='H3') a.className='sub';
    a.addEventListener('click',function(e){
      e.preventDefault();
      h.scrollIntoView({behavior:'smooth',block:'start'});
      history.replaceState(null,'','#'+h.id);
    });
    li.appendChild(a); ul.appendChild(li);
  });
  bar.appendChild(ul);
  var links={};
  [].slice.call(ul.querySelectorAll('a')).forEach(function(a){
    links[a.getAttribute('href').slice(1)]=a;
  });
  function mark(id){
    for(var k in links) links[k].classList.toggle('on',k===id);
    var a=links[id];
    if(a && a.offsetLeft < bar.scrollLeft) bar.scrollLeft=a.offsetLeft-12;
    else if(a && a.offsetLeft+a.offsetWidth > bar.scrollLeft+bar.clientWidth)
      bar.scrollLeft=a.offsetLeft+a.offsetWidth-bar.clientWidth+12;
  }
  var obs=new IntersectionObserver(function(){
    // At the very bottom the last section can never reach the top of the
    // viewport, so scrolling to the end would leave an earlier tab lit.
    if(window.innerHeight+window.scrollY >= document.body.scrollHeight-4){
      mark(heads[heads.length-1].id); return;
    }
    var best=null, bestTop=1e9;
    heads.forEach(function(h){
      var t=h.getBoundingClientRect().top-60;
      if(t<=1 && Math.abs(t)<bestTop){ bestTop=Math.abs(t); best=h.id; }
    });
    mark(best||heads[0].id);
  },{threshold:[0,1],rootMargin:'-56px 0px -70% 0px'});
  window.addEventListener('scroll',function(){
    if(window.innerHeight+window.scrollY >= document.body.scrollHeight-4)
      mark(heads[heads.length-1].id);
  },{passive:true});
  heads.forEach(function(h){ obs.observe(h); });
  mark(heads[0].id);
})();
"""

_DOCTYPE = re.compile(r"<!DOCTYPE[^>]*>", re.I)
_TAG = re.compile(r"</?(?:html|head|body)\b[^>]*>", re.I)
_META_CHARSET = re.compile(r"<meta[^>]+charset[^>]*>", re.I)
_TITLE = re.compile(r"<title>(.*?)</title>", re.I | re.S)


def _inner(html: str) -> str:
    """The content of a page, whether it was written as a fragment or a document.

    Pages older than the shell are complete HTML files; keeping their <html> or
    <head> would nest documents. Their <style> blocks survive the unwrapping —
    they are simply hoisted into the body, which is legal and, as the module
    docstring says, deliberately still overrides the shell.
    """
    out = _DOCTYPE.sub("", html)
    out = _META_CHARSET.sub("", out)
    out = _TITLE.sub("", out)
    out = _TAG.sub("", out)
    return out.strip()


def page_title(html: str, fallback: str) -> str:
    m = _TITLE.search(html or "")
    return (m.group(1).strip() if m else "") or fallback


def _esc(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def wrap(html: str, meta: dict) -> str:
    """Render one analysis page inside the shell.

    `meta` is the graph row: title, description, symbol, as_of, version, actor,
    sources. Everything shown in the masthead comes from there rather than from
    the page, so the stamp cannot drift from what the index says.
    """
    title = _esc(meta.get("title") or page_title(html, "Analysis"))
    stamp = []
    if meta.get("symbol"):
        stamp.append(_esc(str(meta["symbol"])))
    stamp.append(f"as of {_esc(str(meta.get('as_of') or '—'))}")
    stamp.append(f"v{_esc(str(meta.get('version') or 1))}")
    if meta.get("actor"):
        stamp.append(_esc(str(meta["actor"])))
    if meta.get("zettel_refs"):
        stamp.append(f"refs {_esc(str(meta['zettel_refs']))}")

    sources = meta.get("sources") or []
    src_html = ""
    if isinstance(sources, list) and sources:
        items = []
        for s in sources:
            if isinstance(s, dict):
                label = _esc(str(s.get("title") or s.get("url") or ""))
                url = str(s.get("url") or "")
                # Not a link: the CSP forbids navigation targets from a page we
                # did not write, so the URL is printed to be read or copied.
                items.append(f"<li>{label}{f' — {_esc(url)}' if url else ''}</li>")
            else:
                items.append(f"<li>{_esc(str(s))}</li>")
        src_html = (
            '<h2 id="sources">แหล่งอ้างอิง</h2>'
            f'<ul class="src">{"".join(items)}</ul>'
        )

    dek = _esc(meta.get("description") or "")
    return f"""<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{_font_face_css()}{SHELL_CSS}</style>
</head>
<body>
<header class="gs-head">
  <div class="in">
    <div class="gs-kicker">Analysis</div>
    <h1 class="gs-title">{title}</h1>
    {f'<p class="gs-dek">{dek}</p>' if dek else ''}
    <div class="gs-stamp">{"".join(f"<span>{p}</span>" for p in stamp)}</div>
  </div>
</header>
<nav class="gs-tabs" id="gs-tabs"></nav>
<main class="gs-body" id="gs-body">
{_inner(html)}
{src_html}
</main>
<script>{SHELL_JS}</script>
</body>
</html>"""
