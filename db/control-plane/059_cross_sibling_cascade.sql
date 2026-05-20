-- @scope: platform
-- Eliminate the apps-cascade dependency on intra-app NO ACTION FKs.
--
-- Two cross-sibling FKs are NO ACTION:
--   app_subscriptions.plan_id → app_plans
--   app_orders.product_id     → app_products
--
-- Both pairs cascade together from apps today, so account deletion works —
-- but only because every one of those four tables still cascades from apps.
-- If a future migration ever weakens any of those cascades to SET NULL or
-- NO ACTION, account deletion would silently break for users with active
-- subscriptions/orders. Switching the cross-sibling FKs to CASCADE removes
-- that latent dependency: deleting an app_plan now also deletes its
-- app_subscriptions, and deleting an app_product now also deletes its
-- app_orders, regardless of how the parent gets deleted.
--
-- Behavioral change is bounded: in practice, an app_plan or app_product is
-- never deleted while it has active subscriptions/orders (the dashboard
-- soft-deactivates by setting active=false). The CASCADE just makes the
-- "if it ever happens" case consistent with the apps-cascade case.
--
-- Idempotent: drops by name and recreates.

ALTER TABLE app_subscriptions
    DROP CONSTRAINT IF EXISTS app_subscriptions_plan_id_fkey;
ALTER TABLE app_subscriptions
    ADD CONSTRAINT app_subscriptions_plan_id_fkey
    FOREIGN KEY (plan_id) REFERENCES app_plans(id) ON DELETE CASCADE;

ALTER TABLE app_orders
    DROP CONSTRAINT IF EXISTS app_orders_product_id_fkey;
ALTER TABLE app_orders
    ADD CONSTRAINT app_orders_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES app_products(id) ON DELETE CASCADE;
