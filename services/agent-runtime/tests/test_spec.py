import pytest
from pydantic import ValidationError

from agent_runtime.spec import GraphSpec


def test_minimal_valid_llm_graph():
    spec = GraphSpec.model_validate(
        {
            "spec_version": "1",
            "entry": "answer",
            "nodes": {
                "answer": {
                    "type": "llm",
                    "model": "anthropic/claude-3.5-sonnet",
                    "system_prompt": "You are helpful.",
                    "input_template": "{{ state.user_input }}",
                    "output_key": "reply",
                },
                "done": {"type": "end", "output_template": "{{ state.reply }}"},
            },
            "edges": [{"from": "answer", "to": "done"}],
            "tools": {"builtin": [], "mcp_servers": [], "functions": []},
            "limits": {
                "max_steps": 10,
                "max_tool_calls": 0,
                "max_parallel_tools": 1,
                "timeout_seconds": 60,
                "human_timeout_seconds": 86400,
            },
        }
    )
    assert spec.entry == "answer"
    assert spec.nodes["answer"].type == "llm"


def test_rejects_unknown_node_type():
    with pytest.raises(ValidationError):
        GraphSpec.model_validate(
            {
                "spec_version": "1",
                "entry": "x",
                "nodes": {"x": {"type": "router"}},
                "edges": [],
                "tools": {"builtin": [], "mcp_servers": [], "functions": []},
                "limits": {
                    "max_steps": 10, "max_tool_calls": 0, "max_parallel_tools": 1,
                    "timeout_seconds": 60, "human_timeout_seconds": 86400,
                },
            }
        )


def test_rejects_entry_not_in_nodes():
    with pytest.raises(ValidationError):
        GraphSpec.model_validate(
            {
                "spec_version": "1",
                "entry": "missing",
                "nodes": {"a": {"type": "end", "output_template": "x"}},
                "edges": [],
                "tools": {"builtin": [], "mcp_servers": [], "functions": []},
                "limits": {
                    "max_steps": 10, "max_tool_calls": 0, "max_parallel_tools": 1,
                    "timeout_seconds": 60, "human_timeout_seconds": 86400,
                },
            }
        )


def test_llm_node_with_tool_refs():
    spec = GraphSpec.model_validate({
        "spec_version": "1", "entry": "a",
        "nodes": {
            "a": {"type": "llm", "model": "x", "system_prompt": "", "input_template": "",
                  "output_key": "r",
                  "tools": [{"source": "builtin", "name": "query_table"}]},
            "z": {"type": "end", "output_template": "{{ state.r }}"},
        },
        "edges": [{"from": "a", "to": "z"}],
        "tools": {"builtin": ["query_table"], "mcp_servers": [], "functions": []},
        "limits": {"max_steps": 5, "max_tool_calls": 5, "max_parallel_tools": 1,
                   "timeout_seconds": 30, "human_timeout_seconds": 3600},
    })
    assert spec.nodes["a"].tools[0].source == "builtin"


def test_tool_node():
    spec = GraphSpec.model_validate({
        "spec_version": "1", "entry": "t",
        "nodes": {
            "t": {"type": "tool",
                  "tool_ref": {"source": "function", "name": "send_email"},
                  "args_template": {"to": "{{ state.email }}"},
                  "output_key": "sent"},
            "z": {"type": "end", "output_template": "{{ state.sent }}"},
        },
        "edges": [{"from": "t", "to": "z"}],
        "tools": {"builtin": [], "mcp_servers": [], "functions": ["send_email"]},
        "limits": {"max_steps": 5, "max_tool_calls": 5, "max_parallel_tools": 1,
                   "timeout_seconds": 30, "human_timeout_seconds": 3600},
    })
    assert spec.nodes["t"].tool_ref.name == "send_email"
