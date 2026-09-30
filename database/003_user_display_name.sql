BEGIN;

ALTER TABLE public.workbench_users
    ADD COLUMN IF NOT EXISTS display_name text;

UPDATE public.workbench_users
SET display_name = username
WHERE display_name IS NULL OR btrim(display_name) = '';

ALTER TABLE public.workbench_users
    ALTER COLUMN display_name SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workbench_users_display_name_nonempty'
          AND conrelid = 'public.workbench_users'::regclass
    ) THEN
        ALTER TABLE public.workbench_users
            ADD CONSTRAINT workbench_users_display_name_nonempty
            CHECK (btrim(display_name) <> '');
    END IF;
END
$$;

COMMIT;
