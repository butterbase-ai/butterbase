# 承認条件・RLS・既知の制約

[日本語README](../../README.ja.md) · [英語の原文](../../README.md#safety-floor-non-editable)

## 変更できない承認条件

`support_skill`の設定から、次の構造上の条件を解除できません。

1. 操作は「提案 → ポリシー判定 → 実行 → 記録」で進みます。副作用のある操作は`ctx.substrate.propose`を通り、エージェントのツールから直接実行するAPIは公開しません。
2. `support.apply_account_credit`など`requires_human_approval: true`の能力は、`yolo_mode`や自律性設定にかかわらず承認待ちです。
3. 送信先に応じて内部情報を除くフィルターは原文のPhase 3計画です。v1では運営者が返信を手で編集します。
4. 対応できなくなったら人へ引き継ぎます。引き継ぎ先が未設定でも無効化せず、赤い`unescalated_block`として受信トレイへ記録します。

## RLSを追加する

ユーザーIDが`uuid`の列と比較する場合は、`current_user_id()`をキャストします。

```sql
USING (user_id = current_user_id()::uuid)
```

`current_user_id()`の戻り値は`text`です。`memberships.user_id`や`support_tickets.assigned_to`などとキャストなしで比較すると、実行時に`RLS_TYPE_MISMATCH`になります。

## 原文のv1で後回しにした項目

全件は[06-v1-deferred.md](../butterbase/06-v1-deferred.md)にあります。以下は設計記録の項目で、現在のUIの有無とは区別してください。

- 顧客向けの自律返信。v1設計は全返信を運営者が承認し、各問題種別の初期値を`draft_for_approval`にします。現行画面では自律性モードを設定できます。
- 送信文から内部情報を除くフィルター。`send-draft-reply`ではプレースホルダーです。
- 複数ページのWebクロール。`ingest-docs`のWebモードは1ページ単位で、URLごとに呼び出します。
- Skill・Autonomy・IntegrationsのUI改善。原文はv1時点の読み取り用スタブとして記録していますが、現行画面には編集フローがあります。
- サブドメインの`/fn/`。DEP1は2026年6月の`ReadableStream is disturbed`による500を記録しています。現行control-apiは`/fn/:name`を`/v1/{app_id}/fn/:name`へ対応づけますが、この記録は実環境で再検証していません。ウィジェットは`api.butterbase.ai/v1/{app_id}/fn/*`を直接呼びます。
