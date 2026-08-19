"""P2 multi-lane fusion (design 2026-08-19 §4.3).

lanes_active is THE P2 flag-off guard: it must require BOTH flags and honor
the request-level expansion control, so flag-off (either flag) is
byte-identical and `expansion: false` disables lanes for eval control."""
from types import SimpleNamespace


def _settings(understanding=False, lanes=False):
    return SimpleNamespace(
        query_understanding_enabled=understanding,
        query_expansion_lanes_enabled=lanes,
    )


def test_lanes_active_requires_both_flags():
    from app.understanding import lanes_active
    req = SimpleNamespace(expansion=True)
    assert lanes_active(_settings(False, False), req) is False
    assert lanes_active(_settings(True, False), req) is False
    assert lanes_active(_settings(False, True), req) is False
    assert lanes_active(_settings(True, True), req) is True


def test_lanes_active_honors_request_expansion_control():
    from app.understanding import lanes_active
    assert lanes_active(_settings(True, True), SimpleNamespace(expansion=False)) is False


def test_p2_flag_defaults_off():
    from app.config import Settings
    assert Settings.model_fields["query_expansion_lanes_enabled"].default is False
    assert Settings.model_fields["alias_expand_max_groups"].default == 3
    assert Settings.model_fields["alias_expand_max_terms"].default == 2
