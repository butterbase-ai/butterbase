# 外部連携

[日本語READMEに戻る](../../README.ja.md)

### 外部連携

```bash
# List available integrations (curated)
butterbase integrations list --app app_abc123

# Search the full catalog
butterbase integrations list --search salesforce --app app_abc123

# Show configured integrations
butterbase integrations config --app app_abc123

# Enable a toolkit
butterbase integrations configure gmail --app app_abc123

# Disable a toolkit
butterbase integrations disable gmail --app app_abc123

# Generate OAuth URL for an end-user
butterbase integrations connect gmail --redirect-url https://yourapp.com/settings --app app_abc123

# List connected accounts
butterbase integrations connections --app app_abc123

# Disconnect an account
butterbase integrations disconnect <connection-id> --app app_abc123

# List tools for a toolkit
butterbase integrations tools gmail --app app_abc123

# Execute a tool
butterbase integrations execute GMAIL_SEND_EMAIL --data '{"to":"x@y.com","subject":"Hi","body":"Hello"}' --app app_abc123
```
