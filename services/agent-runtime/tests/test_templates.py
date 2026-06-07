import pytest

from agent_runtime.templates import render


def test_simple_substitution():
    assert render("hello {{ state.name }}", {"name": "world"}) == "hello world"


def test_dotted_path():
    assert render(
        "{{ state.user.first_name }}",
        {"user": {"first_name": "Ada"}},
    ) == "Ada"


def test_missing_key_raises():
    with pytest.raises(KeyError):
        render("{{ state.missing }}", {})


def test_no_braces_passes_through():
    assert render("plain text", {"x": 1}) == "plain text"


def test_multiple_substitutions():
    assert render(
        "{{ state.a }} and {{ state.b }}",
        {"a": "1", "b": "2"},
    ) == "1 and 2"
