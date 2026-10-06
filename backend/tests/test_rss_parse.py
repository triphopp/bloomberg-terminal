"""rss.parse_items — the ElementTree headline parser and its feedparser fallback."""
import pytest

import rss

RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Wire &amp; Co</title>
    <link>https://example.com/</link>
    <atom:link href="https://example.com/rss" rel="self"/>
    <item>
      <title>AT&amp;amp;T beats &lt;b&gt;estimates&lt;/b&gt;</title>
      <link> https://example.com/a?x=1 </link>
      <pubDate>Mon, 05 Oct 2026 14:30:00 GMT</pubDate>
      <description><![CDATA[<a href="https://example.com/a">Story</a>&nbsp;&nbsp;<font>Reuters</font>]]></description>
      <media:thumbnail url="https://example.com/t.jpg"/>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/b</link>
      <pubDate>Mon, 05 Oct 2026 10:00:00 -0400</pubDate>
    </item>
    <item>
      <title>No date</title>
      <link>https://example.com/c</link>
    </item>
  </channel>
</rss>"""

ATOM = b"""<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
  <title>Filings</title>
  <entry>
    <title>8-K - Current report</title>
    <link rel="self" href="https://example.com/self"/>
    <link rel="alternate" type="text/html" href="https://example.com/filing"/>
    <updated>2026-10-02T16:05:11-04:00</updated>
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-10-02</summary>
    <yt:videoId>abc123</yt:videoId>
    <media:group><media:title>ignored</media:title><media:thumbnail url="https://example.com/v.jpg"/></media:group>
  </entry>
  <entry>
    <title>Older</title>
    <link href="https://example.com/older"/>
    <published>2026-09-30T08:00:00Z</published>
    <updated>2026-10-01T09:00:00Z</updated>
  </entry>
</feed>"""


def test_rss_items():
    title, items = rss.parse_items(RSS)
    assert title == "Wire & Co"
    assert [i["link"] for i in items] == [
        "https://example.com/a?x=1", "https://example.com/b", "https://example.com/c",
    ]
    first = items[0]
    # Entities resolved through both layers; the tags are the caller's to strip.
    assert first["title"] == "AT&T beats <b>estimates</b>"
    assert first["published"] == "2026-10-05T14:30:00Z"
    assert "Reuters" in first["summary"] and "&nbsp;" not in first["summary"]
    assert first["thumbnail"] == "https://example.com/t.jpg"
    # An offset is converted to UTC, as feedparser's *_parsed fields are.
    assert items[1]["published"] == "2026-10-05T14:00:00Z"
    assert items[2]["published"] == ""


def test_atom_entries():
    title, items = rss.parse_items(ATOM)
    assert title == "Filings"
    first, second = items
    assert first["link"] == "https://example.com/filing"  # rel=alternate, not self
    assert first["published"] == "2026-10-02T20:05:11Z"   # falls back to <updated>
    assert first["title"] == "8-K - Current report"
    assert first["summary"] == "<b>Filed:</b> 2026-10-02"
    assert first["video_id"] == "abc123"
    assert first["thumbnail"] == "https://example.com/v.jpg"
    assert second["link"] == "https://example.com/older"
    assert second["published"] == "2026-09-30T08:00:00Z"   # <published> wins over <updated>


def test_limit_stops_early():
    _, items = rss.parse_items(RSS, limit=2)
    assert [i["title"] for i in items] == ["AT&T beats <b>estimates</b>", "Second"]


def test_leading_whitespace_is_tolerated():
    _, items = rss.parse_items(b"\n  " + RSS)
    assert len(items) == 3


def test_malformed_xml_falls_back_to_feedparser():
    # An unescaped ampersand is not well-formed; feedparser still reads it.
    broken = RSS.replace(b"<title>Second</title>", b"<title>R&D spend rises</title>")
    _, items = rss.parse_items(broken)
    assert [i["link"] for i in items] == [
        "https://example.com/a?x=1", "https://example.com/b", "https://example.com/c",
    ]
    assert "spend rises" in items[1]["title"]
    assert items[0]["published"] == "2026-10-05T14:30:00Z"
    assert items[1]["published"] == "2026-10-05T14:00:00Z"


def test_inline_dtd_is_not_parsed_by_elementtree():
    bomb = (b'<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaa">]>'
            b"<rss><channel><title>x</title><item><title>t &a;</title>"
            b"<link>https://example.com/</link></item></channel></rss>")
    _, items = rss.parse_items(bomb)  # must not raise, must not expand via ElementTree
    assert len(items) == 1


@pytest.mark.parametrize("body", [b"", b"   ", b"<html><body>Access denied</body></html>"])
def test_not_a_feed_raises(body):
    with pytest.raises(ValueError):
        rss.parse_items(body)


@pytest.mark.parametrize("raw,want", [
    ("Mon, 05 Oct 2026 14:30:00 GMT", "2026-10-05T14:30:00Z"),
    ("Mon, 05 Oct 2026 14:30:00 +0700", "2026-10-05T07:30:00Z"),
    ("2026-10-05T14:30:00Z", "2026-10-05T14:30:00Z"),
    ("2026-10-05T14:30:00+09:00", "2026-10-05T05:30:00Z"),
    ("2026-10-05T14:30:00", "2026-10-05T14:30:00Z"),
    ("", ""),
    ("yesterday", ""),
])
def test_to_iso(raw, want):
    assert rss.to_iso(raw) == want
