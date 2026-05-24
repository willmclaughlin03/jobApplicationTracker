-- Additive Phase 2 follow-up migration.
-- Makes billing_subscriptions.status_changed_at database-managed so service
-- code cannot forget or drift the timestamp.

CREATE FUNCTION public.touch_billing_status_changed_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := pg_catalog.now();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER set_billing_subscriptions_status_changed_at
BEFORE UPDATE ON public.billing_subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.touch_billing_status_changed_at();
