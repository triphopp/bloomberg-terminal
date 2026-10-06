"""Open-web reading for NEWS → ASK: fetch one public page as text, search the web.

Three jobs, all read-only:

* `read_page(url)` — download a page and return its main text. Tries the page
  directly first (lxml extraction); when that is refused, empty, a PDF, or a
  page that only renders with JavaScript, it falls back to Jina Reader
  (r.jina.ai — free, keyless, renders the page on their side).
* `web_search(query)` — general web search through a provider that has a free
  tier and a key: Tavily, else Brave. No key → no general search (the keyless
  engines answer scripts with a bot challenge — tested 2026-10-05: DuckDuckGo
  202, Brave 429, Bing RSS returns unrelated results).
* `resolve_news_link(url)` — Google News and Bing News hand out redirect links;
  this turns them into the publisher's own URL so the page can be read.

The URL comes from a model, so it is treated as hostile: http/https on the
default port only, every redirect hop re-checked, and any host that resolves
to a private, loopback or link-local address is refused — the model must not
be able to reach this machine's own services or the LAN through this tool.

Page fetches bypass the per-host upstream observer on purpose: a paywall's 403
is not a data outage and must not fill logs/upstream.jsonl with one "source"
per news site. They are recorded under a single source instead, and only
network-level failures count as failures.
"""

from __future__ import annotations

import ipaddress
import json
import re
import socket
import time
from urllib.parse import parse_qs, quote, urljoin, urlsplit

import requests

import upstream_health

_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,th;q=0.8",
}
_MAX_BYTES = 3_000_000
_MAX_REDIRECTS = 5
_JINA = "https://r.jina.ai/"
_SOURCE = "ASK web read"

#: Below this much extracted text a page is treated as "did not render" and
#: handed to the reader service.
_THIN = 1500


class WebReadError(RuntimeError):
    """Shown to the model as the tool result."""


# ── URL safety ───────────────────────────────────────────────────────────────

def check_public_url(url: str) -> str:
    """Return the URL if it is safe to fetch from this machine, else raise."""
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise WebReadError("only http(s) URLs can be read")
    if parts.username or parts.password:
        raise WebReadError("URLs with credentials are refused")
    if parts.port not in (None, 80, 443):
        raise WebReadError("only the default web ports are allowed")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise WebReadError(f"cannot resolve {parts.hostname}") from exc
    for info in infos:
        if not ipaddress.ip_address(info[4][0]).is_global:
            raise WebReadError("that address is not on the public internet")
    return parts.geturl()


class _PlainSession(requests.Session):
    """A session the upstream observer does not see (see module docstring)."""

    def send(self, request, **kwargs):
        original = getattr(requests.Session.send, "__wrapped__", None)
        if original is None:
            return super().send(request, **kwargs)
        return original(self, request, **kwargs)


def _record(host: str, started: float, exc: BaseException | None = None) -> None:
    kind = upstream_health.classify_exception(exc) if exc else None
    upstream_health.record(_SOURCE, kind, target=host, elapsed=time.time() - started if kind else None)


def _get(url: str, *, headers: dict | None = None, timeout: float = 20) -> requests.Response:
    """GET with every redirect hop checked. The body is capped at _MAX_BYTES."""
    session = _PlainSession()
    for _ in range(_MAX_REDIRECTS + 1):
        url = check_public_url(url)
        host = urlsplit(url).hostname or ""
        started = time.time()
        try:
            resp = session.get(
                url, headers=headers or _UA, timeout=(8, timeout), stream=True, allow_redirects=False
            )
        except requests.RequestException as exc:
            _record(host, started, exc)
            raise WebReadError(f"{host}: {exc.__class__.__name__}") from exc
        _record(host, started)
        if resp.is_redirect and resp.headers.get("location"):
            resp.close()
            url = urljoin(url, resp.headers["location"])
            continue
        body = bytearray()
        for chunk in resp.iter_content(65_536):
            body.extend(chunk)
            if len(body) >= _MAX_BYTES:
                break
        resp.close()
        resp._content = bytes(body)  # noqa: SLF001 — hand back a normal, capped response
        return resp
    raise WebReadError("too many redirects")


# ── News redirect links ──────────────────────────────────────────────────────

def _decode_google_news(url: str) -> str | None:
    """news.google.com/rss/articles/<id> → the publisher's URL (two calls)."""
    import lxml.html

    match = re.search(r"/(?:rss/)?articles/([^/?#]+)", urlsplit(url).path)
    if not match:
        return None
    article_id = match.group(1)
    page = _get(f"https://news.google.com/rss/articles/{article_id}")
    nodes = lxml.html.fromstring(page.content).xpath("//c-wiz/div[@jscontroller]")
    if not nodes:
        return None
    signature, timestamp = nodes[0].get("data-n-a-sg"), nodes[0].get("data-n-a-ts")
    if not signature or not timestamp:
        return None
    request = [
        "garturlreq",
        [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1, None, None, None, None, None, 0, 1],
         "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
        article_id, int(timestamp), signature,
    ]
    started = time.time()
    try:
        resp = _PlainSession().post(
            "https://news.google.com/_/DotsSplashUi/data/batchexecute",
            headers={**_UA, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
            data="f.req=" + quote(json.dumps([[["Fbv4je", json.dumps(request), None, "generic"]]])),
            timeout=15,
        )
    except requests.RequestException as exc:
        _record("news.google.com", started, exc)
        return None
    _record("news.google.com", started)
    try:
        decoded = json.loads(json.loads(resp.text.split("\n\n")[1])[0][2])[1]
    except (IndexError, ValueError, TypeError):
        return None
    return decoded if isinstance(decoded, str) and decoded.startswith("http") else None


def resolve_news_link(url: str) -> str:
    """Publisher URL behind a Google News / Bing News redirect; else the URL as given."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host.endswith("bing.com") and "apiclick" in parts.path:
        target = parse_qs(parts.query).get("url", [""])[0]
        return target or url
    if host == "news.google.com":
        try:
            return _decode_google_news(url) or url
        except WebReadError:
            return url
    return url


# ── Page → text ──────────────────────────────────────────────────────────────

_DROP = (
    "script", "style", "noscript", "template", "svg", "iframe", "form", "nav", "header",
    "footer", "aside", "button", "figure",
)
_BLOCKS = "p|h1|h2|h3|h4|li|blockquote|pre|td|th"


def _extract(html: bytes, encoding: str | None) -> dict:
    import lxml.html

    try:
        parser = lxml.html.HTMLParser(encoding=encoding) if encoding else None
        doc = lxml.html.fromstring(html, parser=parser)
    except Exception as exc:
        raise WebReadError("the page is not readable HTML") from exc

    def meta(*names: str) -> str:
        for name in names:
            found = doc.xpath(f'//meta[@property="{name}" or @name="{name}"]/@content')
            if found and found[0].strip():
                return found[0].strip()
        return ""

    title = meta("og:title") or (doc.findtext(".//title") or "").strip()
    published = meta("article:published_time", "datePublished", "date", "pubdate", "DC.date.issued")
    description = meta("og:description", "description")

    for node in doc.xpath("|".join(f"//{tag}" for tag in _DROP)):
        node.drop_tree()
    # The article body, when the page marks one; else the whole document.
    roots = doc.xpath("//article") or doc.xpath("//main") or doc.xpath('//*[@role="main"]') or [doc]
    root = max(roots, key=lambda n: len(n.text_content()))

    lines: list[str] = []
    seen: set[str] = set()
    for node in root.xpath(".//*[" + " or ".join(f"self::{t}" for t in _BLOCKS.split("|")) + "]"):
        text = re.sub(r"\s+", " ", node.text_content()).strip()
        if len(text) < 2 or text in seen:
            continue
        seen.add(text)
        lines.append(("- " + text) if node.tag == "li" else text)
    return {
        "title": title[:300],
        "published": published[:40],
        "description": description[:500],
        "text": "\n".join(lines),
    }


def _via_reader(url: str) -> dict:
    """Jina Reader: renders the page (JavaScript, PDF) and returns markdown."""
    started = time.time()
    try:
        resp = _PlainSession().get(
            _JINA + url, headers={"Accept": "text/plain", "X-Return-Format": "markdown"}, timeout=(8, 25)
        )
    except requests.RequestException as exc:
        _record("r.jina.ai", started, exc)
        raise WebReadError(f"reader service: {exc.__class__.__name__}") from exc
    _record("r.jina.ai", started)
    if not resp.ok:
        raise WebReadError(f"reader service answered {resp.status_code}")
    resp.encoding = "utf-8"
    body = resp.text
    head, _, content = body.partition("Markdown Content:")
    if not content:
        head, content = "", body
    title = re.search(r"^Title:\s*(.+)$", head, re.M)
    published = re.search(r"^Published Time:\s*(.+)$", head, re.M)
    # Links and images are noise for reading: keep the words, drop the targets.
    content = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", content)
    content = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", content)
    content = re.sub(r"\n{3,}", "\n\n", content).strip()
    return {
        "title": (title.group(1).strip() if title else "")[:300],
        "published": (published.group(1).strip() if published else "")[:40],
        "description": "",
        "text": content,
    }


def read_page(url: str, *, max_chars: int = 8_000, use_reader: bool = True) -> dict:
    """Main text of one public page. Raises WebReadError with a reason the model can act on."""
    url = check_public_url(resolve_news_link(check_public_url(url)))

    page: dict | None = None
    via = "direct"
    reason = ""
    try:
        resp = _get(url)
        url = resp.url or url
        ctype = resp.headers.get("content-type", "").lower()
        if resp.status_code >= 400:
            reason = f"site answered {resp.status_code}"
        elif "pdf" in ctype:
            reason = "PDF"
        elif not any(t in ctype for t in ("html", "xml", "text/plain")) and ctype:
            raise WebReadError(f"not a readable page ({ctype.split(';')[0]})")
        elif "text/plain" in ctype:
            page = {"title": "", "published": "", "description": "", "text": resp.text}
        else:
            match = re.search(r"charset=([\w-]+)", ctype)
            page = _extract(resp.content, match.group(1) if match else None)
            if len(page["text"]) < _THIN:
                reason = "page has almost no text without JavaScript"
    except WebReadError as exc:
        if "not a readable page" in str(exc) or "public internet" in str(exc):
            raise
        reason = str(exc)

    if reason:
        if not use_reader:
            if page and page["text"]:
                pass  # thin, but it is what the page gave
            else:
                raise WebReadError(f"could not read the page: {reason}")
        else:
            try:
                rendered = _via_reader(url)
                if len(rendered["text"]) > len((page or {}).get("text", "")):
                    page, via = rendered, "reader"
            except WebReadError as exc:
                if not (page and page["text"]):
                    raise WebReadError(
                        f"could not read the page: {reason}; {exc}. It may be paywalled — "
                        "use another source for this fact."
                    ) from exc

    if not page or not page["text"].strip():
        raise WebReadError(
            f"could not read the page ({reason or 'no text'}). It may be paywalled or block "
            "automated readers — use another source for this fact."
        )
    text = page["text"]
    return {
        "url": url,
        "title": page["title"],
        "published": page["published"],
        "description": page["description"],
        "via": via,
        "truncated": len(text) > max_chars,
        "text": text[:max_chars],
    }


# ── General web search (keyed free tiers) ────────────────────────────────────

def search_provider(keys: dict) -> str | None:
    if keys.get("tavily"):
        return "Tavily"
    if keys.get("brave"):
        return "Brave"
    return None


def web_search(query: str, keys: dict, max_results: int = 8) -> dict:
    """Ranked web results: title, url, snippet, date when the engine knows it."""
    query = query.strip()[:300]
    if not query:
        raise WebReadError("empty query")

    if keys.get("tavily"):
        resp = requests.post(
            "https://api.tavily.com/search",
            headers={"Authorization": f"Bearer {keys['tavily']}"},
            json={"query": query, "max_results": max_results, "search_depth": "basic"},
            timeout=30,
        )
        if not resp.ok:
            raise WebReadError(f"Tavily answered {resp.status_code}: {resp.text[:200]}")
        results = [
            {"title": r.get("title"), "url": r.get("url"), "snippet": (r.get("content") or "")[:500],
             "published": r.get("published_date")}
            for r in resp.json().get("results", [])
        ]
        return {"provider": "Tavily", "query": query, "results": results}

    if keys.get("brave"):
        resp = requests.get(
            "https://api.search.brave.com/res/v1/web/search",
            headers={"X-Subscription-Token": keys["brave"], "Accept": "application/json"},
            params={"q": query, "count": max_results},
            timeout=30,
        )
        if not resp.ok:
            raise WebReadError(f"Brave answered {resp.status_code}: {resp.text[:200]}")
        results = [
            {"title": r.get("title"), "url": r.get("url"),
             "snippet": re.sub(r"<[^>]+>", "", r.get("description") or "")[:500],
             "published": r.get("page_age") or r.get("age")}
            for r in (resp.json().get("web") or {}).get("results", [])
        ]
        return {"provider": "Brave", "query": query, "results": results}

    raise WebReadError("no web search key configured")
