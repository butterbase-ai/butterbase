// services/control-api/src/routes/llms-txt.ts
import type { FastifyInstance } from 'fastify';

const LLMS_TXT_CONTENT = `# Butterbase Control API - Agent Guidance

> Butterbase provides instant backend infrastructure for AI agents and developers.
> This endpoint provides guidance for LLM agents using the Butterbase MCP server.

## Quick Start for Agents

When a user asks you to "create a backend" or "set up a database":

1. **Initialize app**: Use \`init_app\` with a descriptive name
2. **Define schema**: Use \`manage_schema\` (action: "apply") with table definitions
3. **Set up auth** (optional): Use \`manage_oauth\` (action: "configure") for user authentication
4. **Set up RLS** (optional): Use \`manage_rls\` for row-level security

## Common Patterns

### Creating a Todo App Backend
\`\`\`
1. init_app(name: "my-todo-app")
2. manage_schema(action: "apply") with:
   - todos table: id (uuid, pk), user_id (text), title (text), completed (boolean)
3. manage_rls(action: "create_user_isolation", table_name: "todos", user_column: "user_id")
\`\`\`

### Adding File Storage
\`\`\`
1. manage_storage(action: "upload_url", filename, content_type, size_bytes)
2. User uploads to presigned URL
3. File is automatically tracked in storage_objects table
\`\`\`

## Error Handling

All errors follow this structure:
\`\`\`json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "remediation": "What to do next",
    "documentation_url": "https://docs.butterbase.ai/errors#error-code",
    "details": { /* context-specific data */ }
  }
}
\`\`\`

When you encounter an error:
1. Read the \`remediation\` field - it tells you exactly what to do
2. Check \`details\` for specific values (e.g., current quota usage)
3. Follow the suggested action before retrying

## Response Metadata

Success responses include \`_meta\` with:
- \`resource_info\`: Current state (e.g., table count, storage usage)
- \`next_actions\`: Suggested next steps with tool names

Example:
\`\`\`json
{
  "app_id": "app_123",
  "schema": { ... },
  "_meta": {
    "resource_info": {
      "table_count": 3,
      "tables": ["users", "posts", "comments"]
    },
    "next_actions": [
      {
        "action": "create_user_isolation",
        "description": "Set up row-level security",
        "tool": "manage_rls",
        "when": "After creating tables with user-specific data"
      }
    ]
  }
}
\`\`\`

## Best Practices

1. **Always check for existing apps** before creating new ones
   - Use \`manage_app\` (action: "list") to see what exists
   - Reuse apps when appropriate

2. **Use descriptive names**
   - App names: "user-todo-app", "blog-backend"
   - Migration names: "add-comments-table", "add-user-avatar-column"

3. **Handle destructive changes carefully**
   - Schema changes that drop tables/columns require explicit opt-in
   - Use \`_drop\` array for tables, \`_dropColumns\` for columns
   - Always warn the user before destructive operations

4. **Leverage next_actions**
   - After each operation, check \`_meta.next_actions\`
   - Suggest these actions to the user
   - Example: After creating tables, suggest RLS setup

5. **Monitor quotas**
   - Check \`resource_info\` for quota usage
   - Warn users when approaching limits
   - Storage responses include usage percentage

## Common Workflows

### Full Stack Setup
\`\`\`
1. init_app → get app_id and connection details
2. manage_schema (action: "apply") → create tables
3. manage_rls (action: "create_user_isolation") → secure user data
4. manage_oauth (action: "configure") → enable user login
5. Share API endpoint and auth URLs with user
\`\`\`

### Schema Evolution
\`\`\`
1. manage_schema (action: "get") → see current state
2. manage_schema (action: "dry_run") → preview changes
3. Review changes with user
4. manage_schema (action: "apply") → execute migration
\`\`\`

### Storage Management
\`\`\`
1. manage_storage (action: "upload_url") → get presigned URL
2. User uploads file
3. manage_storage (action: "list") → list files
4. manage_storage (action: "download_url") → get download link
5. manage_storage (action: "delete") → remove file
\`\`\`

### Custom Domains
\`\`\`
1. manage_frontend (action: "configure_custom_domain", domain_action: "add") → register hostname
2. User adds CNAME record at their DNS provider
3. manage_frontend (action: "configure_custom_domain", domain_action: "status") → poll until active
4. Domain is live with automatic SSL
\`\`\`

## Documentation

- Full API docs: https://docs.butterbase.ai
- Error reference: https://docs.butterbase.ai/errors
- Schema DSL: https://docs.butterbase.ai/core-concepts/database/
- MCP tools: Use \`butterbase_docs\` tool for detailed reference

## Support

If you encounter issues:
1. Check error \`remediation\` field
2. Review \`butterbase_docs\` for detailed tool documentation
3. Verify input format matches examples
4. Check that app_id exists with \`manage_app\` (action: "list")

---

This guidance is optimized for LLM agents. For human developers, see https://docs.butterbase.ai
`;

export async function llmsTxtRoutes(app: FastifyInstance) {
  app.get('/llms.txt', async (request, reply) => {
    return reply
      .type('text/plain; charset=utf-8')
      .send(LLMS_TXT_CONTENT);
  });
}
