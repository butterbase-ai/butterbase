# Todoのスキーマ

[バックエンド設定](../../BUTTERBASE_SETUP.ja.md)

`manage_schema`の`apply`で、次の原文と共通のJSONを指定します。`user_id`・画像のobjectId・完了状態・timestamp・indexを定義します。

```json
{
  "tables": {
    "todos": {
      "columns": {
        "id": {
          "type": "uuid",
          "primaryKey": true,
          "default": "gen_random_uuid()"
        },
        "user_id": {
          "type": "uuid",
          "nullable": false
        },
        "title": {
          "type": "text",
          "nullable": false
        },
        "description": {
          "type": "text",
          "nullable": true
        },
        "completed": {
          "type": "boolean",
          "default": "false"
        },
        "image_url": {
          "type": "text",
          "nullable": true
        },
        "created_at": {
          "type": "timestamp",
          "default": "now()"
        },
        "updated_at": {
          "type": "timestamp",
          "default": "now()"
        }
      },
      "indexes": {
        "user_id_idx": {
          "columns": ["user_id"]
        },
        "created_at_idx": {
          "columns": ["created_at"]
        }
      }
    }
  }
}
```
