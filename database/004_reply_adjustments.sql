BEGIN;
CREATE TABLE IF NOT EXISTS public.draft_adjustments (
  request_id uuid PRIMARY KEY,
  root_draft_id uuid NOT NULL REFERENCES public.draft_runs(id),
  parent_draft_id uuid NOT NULL UNIQUE REFERENCES public.draft_runs(id),
  draft_run_id uuid NOT NULL UNIQUE REFERENCES public.draft_runs(id),
  round integer NOT NULL CHECK (round BETWEEN 1 AND 3),
  instruction text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_draft_id, round),
  CHECK (parent_draft_id <> draft_run_id)
);
GRANT SELECT, INSERT ON public.draft_adjustments TO aiuser;
COMMIT;
