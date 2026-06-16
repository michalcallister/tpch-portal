-- ============================================================
-- Idiot-proof the per-staff commission display setting
-- Applied: 2026-06-16
--
-- Problem: a team member set to "Custom" with a blank amount is an invalid
-- half-state. The portal silently falls back to the portal rate for them, and
-- the owner/admin management view reads confusingly ("Fixed: —"). It happens
-- when someone picks "Custom", the amount box appears, and the row is saved
-- before a figure is entered.
--
-- Fix (data-layer guard): a BEFORE INSERT/UPDATE trigger on partner_staff that
-- normalises every write — from the UI, the invite edge function, the REST API,
-- or direct SQL — so the bad state can never persist:
--   * "custom" + blank amount  -> "portal" (null amount)
--   * any non-"custom" type     -> null amount (no stray leftover value)
--
-- Paired with client-side validation in the Add/Edit Team Member screens
-- (index.html) that blocks saving "Custom" without an amount, and a one-off
-- cleanup of existing rows (run separately).
-- ============================================================

CREATE OR REPLACE FUNCTION public.normalise_staff_comm_display()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = ''
AS $function$
BEGIN
  IF NEW.comm_display_type = 'custom'
     AND (NEW.comm_custom_value IS NULL OR btrim(NEW.comm_custom_value) = '') THEN
    NEW.comm_display_type := 'portal';
    NEW.comm_custom_value := NULL;
  ELSIF NEW.comm_display_type IS DISTINCT FROM 'custom' THEN
    NEW.comm_custom_value := NULL;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_normalise_staff_comm_display ON public.partner_staff;
CREATE TRIGGER trg_normalise_staff_comm_display
  BEFORE INSERT OR UPDATE ON public.partner_staff
  FOR EACH ROW EXECUTE FUNCTION public.normalise_staff_comm_display();

-- One-off cleanup of existing invalid rows (idempotent):
-- UPDATE public.partner_staff
--   SET comm_display_type = 'portal', comm_custom_value = NULL
--   WHERE comm_display_type = 'custom'
--     AND (comm_custom_value IS NULL OR btrim(comm_custom_value) = '');
