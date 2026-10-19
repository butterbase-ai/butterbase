-- @scope: platform
-- @phase: pre-deploy
-- Durable closure of explicitly identified reservations. Apply before deploying
-- lease-service callers that pass reservationId. Existing anonymous grants do
-- not access this table. Do not delete closure rows while delayed callers can
-- replay: they prevent a reservation from being created after terminal cleanup.
BEGIN;
CREATE TABLE credit_reservation_closures (
  reservation_id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  had_lease boolean NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now()
);
-- No organization/app FK: billing closure must survive subject deletion.
CREATE FUNCTION protect_credit_reservation_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit reservation closure is immutable';
END $$;
CREATE TRIGGER credit_reservation_closures_immutable
  BEFORE UPDATE OR DELETE ON credit_reservation_closures
  FOR EACH ROW EXECUTE FUNCTION protect_credit_reservation_closure();
COMMIT;
