BEGIN;

ALTER TABLE public.draft_runs
    ADD COLUMN IF NOT EXISTS system_version text;

UPDATE public.draft_runs
SET system_version = 'legacy-unknown'
WHERE system_version IS NULL OR btrim(system_version) = '';

ALTER TABLE public.draft_runs
    ALTER COLUMN system_version SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'draft_runs_system_version_nonempty'
          AND conrelid = 'public.draft_runs'::regclass
    ) THEN
        ALTER TABLE public.draft_runs
            ADD CONSTRAINT draft_runs_system_version_nonempty
            CHECK (btrim(system_version) <> '');
    END IF;
END
$$;

COMMIT;
