/**
 * Tool catalog for the dashboard assistant.
 * Exposes a curated list of MCP tools to the agent.
 */

export type ToolSpec = {
  name: string;
  description: string;
  parameters: object; // JSON schema
};

export function getToolCatalog(): ToolSpec[] {
  return [
    {
      name: 'manage_app',
      description:
        'Manage app lifecycle: list, delete, pause/resume, get config, update access mode, secure, update CORS, clone, find templates, and migrate regions. Actions: "list", "delete", "pause", "get_config", "set_visibility", "update_access_mode", "secure", "update_cors", "preview_clone_env_vars", "clone", "get_clone_job", "find_templates", "set_clone_webhook", "link_substrate", "unlink_substrate", "set_substrate_autopropagate", "move", "move_status", "teardown_source_replica", "get_env", "update_env".',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list',
              'delete',
              'pause',
              'get_config',
              'set_visibility',
              'update_access_mode',
              'secure',
              'update_cors',
              'preview_clone_env_vars',
              'clone',
              'get_clone_job',
              'find_templates',
              'set_clone_webhook',
              'link_substrate',
              'unlink_substrate',
              'set_substrate_autopropagate',
              'move',
              'move_status',
              'teardown_source_replica',
              'get_env',
              'update_env',
            ],
            description: 'The action to perform',
          },
          params: {
            type: 'object',
            additionalProperties: true,
            description:
              'Action-specific parameters. See tool description for required fields per action.',
          },
        },
        required: ['action'],
      },
    },
  ];
}
