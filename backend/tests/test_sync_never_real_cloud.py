"""Tests must never see the real cloud folder (see tests/conftest.py)."""
from sync import config as cfg


def test_sync_is_off_unless_a_test_opts_in():
    assert cfg.enabled() is False
    assert cfg.sync_dir() is None
