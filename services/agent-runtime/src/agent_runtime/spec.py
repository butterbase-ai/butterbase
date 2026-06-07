"""Graph spec model. Plan 1 supports llm + end nodes only."""

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field, model_validator


class LimitsSpec(BaseModel):
    max_steps: int = Field(ge=1, le=200)
    max_tool_calls: int = Field(ge=0, le=500)
    max_parallel_tools: int = Field(ge=1, le=16)
    timeout_seconds: int = Field(ge=5, le=3600)
    human_timeout_seconds: int = Field(ge=60, le=7 * 24 * 3600)
    heartbeat_seconds: int = Field(default=5, ge=1, le=60)
    checkpoint_every_node: bool = True


# ---------------------------------------------------------------------------
# Tool references
# ---------------------------------------------------------------------------

class ToolRefBuiltin(BaseModel):
    source: Literal["builtin"]
    name: str
    mode_override: Literal["read_only", "read_write"] | None = None
    exposed_to_override: Literal["developer_only", "end_user"] | None = None


class ToolRefMcp(BaseModel):
    source: Literal["mcp"]
    server_id: str
    name: str
    mode_override: Literal["read_only", "read_write"] | None = None
    exposed_to_override: Literal["developer_only", "end_user"] | None = None


class ToolRefFunction(BaseModel):
    source: Literal["function"]
    name: str
    mode_override: Literal["read_only", "read_write"] | None = None
    exposed_to_override: Literal["developer_only", "end_user"] | None = None


ToolRef = Annotated[
    Union[ToolRefBuiltin, ToolRefMcp, ToolRefFunction],
    Field(discriminator="source"),
]


class ToolRefOverride(BaseModel):
    mode_override: Literal["read_only", "read_write"] | None = None
    exposed_to_override: Literal["developer_only", "end_user"] | None = None
    model_config = {"extra": "forbid"}


class McpServerEntry(BaseModel):
    server_id: str
    tools: list[str]
    tool_overrides: dict[str, ToolRefOverride] = {}


class ToolsSpec(BaseModel):
    builtin: list[str] = []
    mcp_servers: list[McpServerEntry] = []
    functions: list[str] = []


# ---------------------------------------------------------------------------
# Node types
# ---------------------------------------------------------------------------

class LlmNode(BaseModel):
    type: Literal["llm"]
    model: str
    system_prompt: str
    input_template: str
    output_key: str
    tools: list[ToolRef] = []
    temperature: float | None = None
    max_tokens: int | None = None


class ToolNode(BaseModel):
    type: Literal["tool"]
    tool_ref: ToolRef
    args_template: dict[str, Any]
    output_key: str


class EndNode(BaseModel):
    type: Literal["end"]
    output_template: str


NodeSpec = Annotated[
    Union[LlmNode, ToolNode, EndNode], Field(discriminator="type")
]


class EdgeSpec(BaseModel):
    from_: str = Field(alias="from", serialization_alias="from")
    to: str

    model_config = {"populate_by_name": True}


class GraphSpec(BaseModel):
    spec_version: Literal["1"]
    entry: str
    nodes: dict[str, NodeSpec]
    edges: list[EdgeSpec]
    tools: ToolsSpec
    limits: LimitsSpec

    @model_validator(mode="after")
    def _check_entry_and_edges(self):
        if self.entry not in self.nodes:
            raise ValueError(f"entry node '{self.entry}' not in nodes")
        for edge in self.edges:
            if edge.from_ not in self.nodes:
                raise ValueError(f"edge from unknown node '{edge.from_}'")
            if edge.to not in self.nodes:
                raise ValueError(f"edge to unknown node '{edge.to}'")
        return self
