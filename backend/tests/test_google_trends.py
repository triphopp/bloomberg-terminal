"""Offline tests for routers/google_trends.py parsing — no network."""

from routers.google_trends import _strip_xssi, parse_daily_rss

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel>
<title>Daily Search Trends</title>
<item>
  <title>ราคาทองวันนี้</title>
  <ht:approx_traffic>2000+</ht:approx_traffic>
  <pubDate>Mon, 28 Sep 2026 04:30:00 -0700</pubDate>
  <ht:news_item>
    <ht:news_item_title>Gold falls</ht:news_item_title>
    <ht:news_item_snippet/>
    <ht:news_item_url>https://example.com/gold</ht:news_item_url>
    <ht:news_item_source>Example</ht:news_item_source>
  </ht:news_item>
  <ht:news_item><ht:news_item_snippet/></ht:news_item>
</item>
<item><title>second</title></item>
</channel></rss>"""


def test_parse_daily_rss():
    items = parse_daily_rss(RSS)
    assert [i["query"] for i in items] == ["ราคาทองวันนี้", "second"]
    first = items[0]
    assert first["approx_traffic"] == "2000+"
    assert first["published_at"] == "2026-09-28T11:30:00+00:00"   # -0700 → UTC
    # the empty news_item is dropped
    assert first["news"] == [{"title": "Gold falls", "url": "https://example.com/gold", "source": "Example"}]
    assert items[1]["approx_traffic"] is None and items[1]["news"] == []


def test_strip_xssi():
    assert _strip_xssi(')]}\',\n{"a": 1}') == {"a": 1}
    assert _strip_xssi(')]}\'\n{"widgets": []}') == {"widgets": []}
