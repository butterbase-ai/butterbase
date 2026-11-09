# 認証・アプリ・スキーマ

[日本語READMEに戻る](../../README.ja.md)

### 認証

```bash
# Login
butterbase login

# Logout
butterbase logout
```


### 設定

```bash
# Show current config
butterbase config get

# Set endpoint
butterbase config set endpoint https://api.butterbase.ai

# Set API key
butterbase config set apiKey bb_sk_...
```

設定は `~/.butterbase/config.json` に保存します。


### アプリ

```bash
# List all apps
butterbase apps list

# Create new app
butterbase apps create my-app

# Set current app (used by other commands)
butterbase apps use app_abc123

# Delete app
butterbase apps delete app_abc123
```


### スキーマ

```bash
# Get current schema
butterbase schema get

# Save schema to file
butterbase schema get --output schema.json

# Preview schema changes (dry-run)
butterbase schema apply schema.json --dry-run

# Apply schema changes
butterbase schema apply schema.json

# Apply with custom migration name
butterbase schema apply schema.json --name "add_users_table"

# Use specific app
butterbase schema get --app app_abc123
```
