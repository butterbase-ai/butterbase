# 関数・ファイル保存・AI

[日本語READMEに戻る](../../README.ja.md)

### 関数

```bash
# List deployed functions
butterbase functions list

# Deploy function
butterbase functions deploy ./functions/hello.ts

# Deploy with custom name
butterbase functions deploy ./functions/hello.ts --name my-function

# Deploy with description
butterbase functions deploy ./functions/hello.ts --description "Hello world function"

# Deploy cron function
butterbase functions deploy ./functions/cleanup.ts --trigger cron

# View function logs
butterbase functions logs my-function

# View error logs only
butterbase functions logs my-function --level error

# Limit number of logs
butterbase functions logs my-function --limit 50
```


### ファイル保存

```bash
# List storage objects
butterbase storage list

# Upload file
butterbase storage upload ./image.png

# Delete object
butterbase storage delete obj_abc123
```


### AI

```bash
butterbase ai chat "Summarize this" --model openai/gpt-4o-mini
butterbase ai chat "Explain RAG" --system "You're a concise teacher." --temperature 0.2
butterbase ai embed "hello world" "another doc"
butterbase ai models
butterbase ai config get
butterbase ai config set --default-model openai/gpt-4o-mini --max-tokens-per-request 4000
butterbase ai config set --byok-key sk-or-...           # rotate BYOK key; "" to clear
butterbase ai usage --start-date 2026-05-01 --end-date 2026-05-31
```


### OAuth（管理者向け）

```bash
butterbase oauth configure google \
  --client-id ... --client-secret ... \
  --redirect-uri https://app.example/cb \
  --scope openid --scope email
butterbase oauth list
butterbase oauth get google
butterbase oauth update google --enabled false
butterbase oauth delete google
```


### 監査ログ

```bash
butterbase audit query --category auth --event-type login --limit 50
butterbase audit query --from 2026-05-01 --to 2026-05-31 --action create --resource-type user
butterbase audit query --actor-id user_123 --json
```
