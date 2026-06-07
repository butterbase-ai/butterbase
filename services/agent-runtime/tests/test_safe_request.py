import pytest
from agent_runtime.safe_request import is_safe_destination, SafeRequestError


@pytest.mark.parametrize("ip,ok", [
    ("8.8.8.8", True),
    ("1.1.1.1", True),
    ("127.0.0.1", False),
    ("10.0.0.1", False),
    ("172.16.5.4", False),
    ("192.168.1.10", False),
    ("169.254.169.254", False),  # IMDS
    ("fe80::1", False),           # link-local v6
    ("::1", False),               # loopback v6
    ("0.0.0.0", False),
])
def test_is_safe_destination(ip, ok):
    assert is_safe_destination(ip) is ok
