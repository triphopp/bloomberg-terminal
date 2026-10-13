"""Nobody decides what "all accounts" means except account_scope.py.

"all" used to be the absence of a WHERE clause, so every account that existed
was part of the personal book. A fund's accounts are not (plans/fund-book.md,
D5), and the only way to keep that true as code is added is to keep the
decision in one place. A line that tests an account id against "all" by hand
fails here; a place where "all" is a stored label rather than a filter says so
with `# scope-ok: <reason>`.
"""
import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent

_VAR = r"(?:account_id|acct_id|aid|acc|scope)"
_ALL = r"[\"']all[\"']"
_HAND_WRITTEN = re.compile(
    rf"\b{_VAR}\s*(?:==|!=)\s*{_ALL}"                    # account_id != "all"
    rf"|{_ALL}\s*(?:==|!=)\s*{_VAR}\b"                   # "all" == account_id
    rf"|\b{_VAR}\s+(?:not\s+)?in\s*\([^)\n]*{_ALL}[^)\n]*\)"   # account_id in (None, "all")
)
_SKIP_DIRS = {"tests", "scripts", "__pycache__", "venv", ".venv", "backups", "cache"}


def _sources():
    for path in sorted(BACKEND.rglob("*.py")):
        rel = path.relative_to(BACKEND)
        if _SKIP_DIRS & set(rel.parts) or rel.name == "account_scope.py":
            continue
        yield rel, path.read_text(encoding="utf-8")


def test_no_hand_written_all_filter():
    offenders = []
    for rel, text in _sources():
        for n, line in enumerate(text.splitlines(), 1):
            if _HAND_WRITTEN.search(line) and "# scope-ok:" not in line:
                offenders.append(f"{rel}:{n}: {line.strip()}")
    assert not offenders, (
        "Use account_scope.where / is_all / account_of instead of comparing an "
        "account id with \"all\" (or mark a stored label `# scope-ok: <reason>`):\n"
        + "\n".join(offenders))


def test_the_rule_sees_the_shapes_it_is_meant_to():
    for line in ('if account_id and account_id != "all":',
                 "x = None if account_id == 'all' else account_id",
                 'aid = None if account_id in (None, "", "all") else account_id',
                 'if "all" != scope:'):
        assert _HAND_WRITTEN.search(line), line
    for line in ('status: str = "all"', 'rets.dropna(how="all")', 'key = f"{account_id or \'all\'}"',
                 'def get_ticker(account_id: str = Query("all")):'):
        assert not _HAND_WRITTEN.search(line), line
