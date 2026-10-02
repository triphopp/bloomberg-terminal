"""Analysis-page files under op-log sync (sync/oplog.py sync_pages / run_round).

The op-log moves `graphs` ROWS; the HTML file each row names has to travel
beside it or the other machine lists a page it renders as 404. Every path here
is a temp dir — the real research/graphs and the real Drive folder are never
touched.
"""
import sqlite3

import pytest

from sync import files, oplog


def _book(*slugs, deleted=()):
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE graphs(slug TEXT PRIMARY KEY, deleted_at TEXT)")
    for s in slugs:
        c.execute("INSERT INTO graphs VALUES(?, ?)", (s, "2026-09-27" if s in deleted else None))
    return c


def _page(graphs_dir, slug, html):
    p = graphs_dir / slug / "index.html"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(html, encoding="utf-8")
    return p


@pytest.fixture()
def devices(tmp_path, monkeypatch):
    """Two machines' graph folders + one cloud root; `use(dev)` points files.py at one."""
    dirs = {"A": tmp_path / "A" / "graphs", "B": tmp_path / "B" / "graphs"}
    for d in dirs.values():
        d.mkdir(parents=True)
    base = tmp_path / "cloud"
    (base / "oplog").mkdir(parents=True)

    def use(dev):
        monkeypatch.setattr(files, "_graphs_dir", lambda: dirs[dev])

    return dirs, base, use


def test_page_made_on_one_device_reaches_the_other(devices):
    dirs, base, use = devices
    _page(dirs["A"], "axti-event-study", "<h2>AXTI</h2>")

    use("A")
    out = oplog.sync_pages(_book("axti-event-study"), base, "A")
    assert out["sent"] == ["axti-event-study"]
    assert (base / "research" / "axti-event-study" / "index.html").exists()

    use("B")  # B got the row through the op-log, not the file
    out = oplog.sync_pages(_book("axti-event-study"), base, "B")
    assert out["taken"] == ["axti-event-study"]
    assert (dirs["B"] / "axti-event-study" / "index.html").read_text(encoding="utf-8") == "<h2>AXTI</h2>"


def test_edit_travels_and_unchanged_round_is_a_no_op(devices):
    dirs, base, use = devices
    _page(dirs["A"], "p", "v1")
    use("A"); oplog.sync_pages(_book("p"), base, "A")
    use("B"); oplog.sync_pages(_book("p"), base, "B")

    _page(dirs["A"], "p", "v2")
    use("A"); assert oplog.sync_pages(_book("p"), base, "A")["sent"] == ["p"]
    use("B"); assert oplog.sync_pages(_book("p"), base, "B")["taken"] == ["p"]
    assert (dirs["B"] / "p" / "index.html").read_text(encoding="utf-8") == "v2"

    use("A"); again = oplog.sync_pages(_book("p"), base, "A")
    assert again["sent"] == [] and again["taken"] == []


def test_deleted_row_is_not_published(devices):
    dirs, base, use = devices
    _page(dirs["A"], "gone", "x")
    use("A")
    oplog.sync_pages(_book("gone", deleted=("gone",)), base, "A")
    assert not (base / "research" / "gone").exists()


def test_run_round_uses_sync_root_not_oplog_root(devices, monkeypatch):
    """Pages live in <SYNC_DIR>/graphs — the folder snapshot sync already filled."""
    dirs, base, use = devices
    _page(dirs["A"], "p", "x")
    use("A")
    monkeypatch.setattr(oplog, "sync_once", lambda conn, device, root: {"flushed": 0})
    out = oplog.run_round(_book("p"), "A", base / "oplog")
    assert out["flushed"] == 0 and out["pages"]["sent"] == ["p"]
    assert (base / "research" / "p" / "index.html").exists()
    assert not (base / "oplog" / "research").exists()


def test_page_failure_does_not_break_the_row_round(devices, monkeypatch):
    dirs, base, use = devices
    monkeypatch.setattr(oplog, "sync_once", lambda conn, device, root: {"flushed": 3})

    def boom(*a, **k):
        raise OSError("drive offline")

    monkeypatch.setattr(oplog, "sync_pages", boom)
    out = oplog.run_round(_book(), "A", base / "oplog")
    assert out["flushed"] == 3 and "drive offline" in out["pages"]["error"]


def test_both_devices_edit_keeps_both_and_reports_it(devices):
    dirs, base, use = devices
    _page(dirs["A"], "p", "v1")
    use("A"); oplog.sync_pages(_book("p"), base, "A")
    use("B"); oplog.sync_pages(_book("p"), base, "B")

    _page(dirs["A"], "p", "A-edit")
    _page(dirs["B"], "p", "B-edit")
    use("A"); assert oplog.sync_pages(_book("p"), base, "A")["sent"] == ["p"]
    use("B"); out = oplog.sync_pages(_book("p"), base, "B")
    assert out["taken"] == [] and out["sent"] == []
    assert {s["why"] for s in out["skipped"]} >= {"local page also changed"}
    assert (dirs["B"] / "p" / "index.html").read_text(encoding="utf-8") == "B-edit"
    assert (base / "research" / "p" / "index.html").read_text(encoding="utf-8") == "A-edit"


def test_manifest_from_before_seen_still_takes_an_edit_once_in_step(devices):
    """Entries written before `seen` existed: the first in-step round records the device."""
    import json
    dirs, base, use = devices
    _page(dirs["A"], "p", "v1")
    use("A"); oplog.sync_pages(_book("p"), base, "A")
    use("B"); oplog.sync_pages(_book("p"), base, "B")
    m = base / "research" / "manifest.json"
    data = json.loads(m.read_text(encoding="utf-8"))
    data["pages"]["p"].pop("seen")
    m.write_text(json.dumps(data), encoding="utf-8")

    use("B"); oplog.sync_pages(_book("p"), base, "B")  # in step → records B
    _page(dirs["A"], "p", "v2")
    use("A"); oplog.sync_pages(_book("p"), base, "A")
    use("B"); assert oplog.sync_pages(_book("p"), base, "B")["taken"] == ["p"]


# ── cloud folder graphs/ → research/ (2026-10-02) ────────────────────────────

def test_an_old_cloud_folder_is_renamed_and_keeps_working(devices):
    dirs, base, use = devices
    use("A")
    _page(dirs["A"], "p", "v1")
    files.push_files(base, ["p"], "A")
    (base / "research").rename(base / "graphs")          # what an older build left behind

    use("B")
    assert files.pull_files(base, ["p"], "B")["taken"] == ["p"]
    assert (base / "research" / "p" / "index.html").exists()
    assert not (base / "graphs").exists()
    assert (dirs["B"] / "p" / "index.html").read_text(encoding="utf-8") == "v1"


def test_a_peer_on_old_code_publishing_into_graphs_is_still_heard(devices):
    dirs, base, use = devices
    use("A")
    _page(dirs["A"], "p", "v1")
    _page(dirs["A"], "q", "same")
    files.push_files(base, ["p", "q"], "A")

    # The old build on B recreates graphs/ and publishes a newer `p` there, plus
    # a `q` that is identical and a page whose file Drive has not finished writing.
    import json
    old = base / "graphs"
    _page(old, "p", "v2-from-old-peer")
    _page(old, "q", "same")
    _page(old, "half", "partial")
    (old / "manifest.json").write_text(json.dumps({"pages": {
        "p": {"sha": files._sha(old / "p" / "index.html"), "updated_at": "9999-01-01", "device": "B"},
        "q": {"sha": files._sha(old / "q" / "index.html"), "updated_at": "9999-01-01", "device": "B"},
        "half": {"sha": "not-the-file", "updated_at": "9999-01-01", "device": "B"},
    }}), encoding="utf-8")

    assert files.adopt_legacy(base) == {"renamed": False, "adopted": ["p"]}
    assert (old / "p" / "index.html").exists()            # nothing is deleted from the old folder
    assert files.adopt_legacy(base)["adopted"] == []      # and a second round is a no-op
    assert files.pull_files(base, ["p"], "A")["taken"] == ["p"]
    assert (dirs["A"] / "p" / "index.html").read_text(encoding="utf-8") == "v2-from-old-peer"
