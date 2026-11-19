# 使用例

[日本語READMEに戻る](../../README.ja.md)

## 使用例

### 一連の操作

```bash
# 1. Login
butterbase login

# 2. Create app
butterbase apps create my-grocery-app

# 3. Set as current
butterbase apps use app_abc123

# 4. Create schema file
cat > schema.json <<EOF
{
  "tables": {
    "grocery_items": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "name": { "type": "text" },
        "quantity": { "type": "integer", "default": "1" },
        "purchased": { "type": "boolean", "default": "false" },
        "user_id": { "type": "uuid" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
EOF

# 5. Apply schema
butterbase schema apply schema.json

# 6. Deploy function
butterbase functions deploy ./functions/add-item.ts

# 7. Upload image
butterbase storage upload ./logo.png
```

### 複数アプリの操作

```bash
# Create production app
butterbase apps create my-app-prod
# Returns: app_prod123

# Create staging app
butterbase apps create my-app-staging
# Returns: app_staging456

# Deploy to production
butterbase functions deploy ./functions/api.ts --app app_prod123

# Deploy to staging
butterbase functions deploy ./functions/api.ts --app app_staging456

# Switch between apps
butterbase apps use app_prod123
butterbase apps use app_staging456
```
