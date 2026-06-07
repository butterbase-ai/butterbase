from agent_runtime.tools.acl import resolve_acl, AclInputs

def test_builtin_default():
    out = resolve_acl(AclInputs(
        source="builtin", default_mode="read_only",
        default_exposed_to="end_user",
    ))
    assert out == ("read_only", "end_user")

def test_mcp_server_override_narrows():
    out = resolve_acl(AclInputs(
        source="mcp", default_mode="read_only", default_exposed_to="developer_only",
        server_override={"mode": "read_only", "exposed_to": "developer_only"},
        spec_override={"mode_override": "read_only"},
    ))
    assert out == ("read_only", "developer_only")

def test_spec_cannot_widen_to_read_write():
    out = resolve_acl(AclInputs(
        source="builtin", default_mode="read_only", default_exposed_to="end_user",
        spec_override={"mode_override": "read_write"},
    ))
    assert out == ("read_only", "end_user")

def test_spec_can_narrow():
    out = resolve_acl(AclInputs(
        source="builtin", default_mode="read_write", default_exposed_to="end_user",
        spec_override={"mode_override": "read_only"},
    ))
    assert out == ("read_only", "end_user")
