CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.knowledge_releases (
    version text PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('building', 'verified', 'active', 'retired', 'failed')),
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    embedding_model text NOT NULL,
    embedding_dimension integer NOT NULL CHECK (embedding_dimension = 1024),
    expected_counts jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    activated_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_releases_one_active
    ON public.knowledge_releases ((status)) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.business_faq_cards (
    card_id text NOT NULL,
    release_version text NOT NULL REFERENCES public.knowledge_releases(version),
    question text NOT NULL,
    answer text NOT NULL,
    category text NOT NULL,
    source_snapshot jsonb NOT NULL,
    content_vector vector(1024),
    status text NOT NULL,
    PRIMARY KEY (card_id, release_version)
);

CREATE TABLE IF NOT EXISTS public.business_faq_phrases (
    card_id text NOT NULL,
    release_version text NOT NULL,
    phrase text NOT NULL,
    position integer NOT NULL,
    phrase_vector vector(1024),
    PRIMARY KEY (card_id, release_version, position),
    FOREIGN KEY (card_id, release_version)
        REFERENCES public.business_faq_cards(card_id, release_version)
);

CREATE TABLE IF NOT EXISTS public.workbench_products (
    product_id text NOT NULL,
    release_version text NOT NULL REFERENCES public.knowledge_releases(version),
    title text NOT NULL,
    category text,
    source text,
    link text,
    stable_facts jsonb NOT NULL,
    sale_status_snapshot text,
    recommendable_snapshot boolean NOT NULL,
    PRIMARY KEY (product_id, release_version)
);

CREATE TABLE IF NOT EXISTS public.workbench_skus (
    sku_id text NOT NULL,
    product_id text NOT NULL,
    release_version text NOT NULL,
    sku_no text,
    item_no text,
    barcode text,
    specification text,
    PRIMARY KEY (sku_id, release_version),
    FOREIGN KEY (product_id, release_version)
        REFERENCES public.workbench_products(product_id, release_version)
);

CREATE TABLE IF NOT EXISTS public.workbench_product_chunks (
    chunk_id text NOT NULL,
    product_id text NOT NULL,
    release_version text NOT NULL,
    chunk_type text NOT NULL,
    stable_facts jsonb NOT NULL,
    combined_text text NOT NULL,
    content_vector vector(1024),
    status text NOT NULL,
    PRIMARY KEY (chunk_id, release_version),
    FOREIGN KEY (product_id, release_version)
        REFERENCES public.workbench_products(product_id, release_version)
);

CREATE TABLE IF NOT EXISTS public.import_checkpoints (
    release_version text NOT NULL REFERENCES public.knowledge_releases(version),
    stream_name text NOT NULL,
    last_row integer NOT NULL CHECK (last_row >= 0),
    rows_imported integer NOT NULL CHECK (rows_imported >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (release_version, stream_name)
);

CREATE TABLE IF NOT EXISTS public.embedding_failures (
    release_version text NOT NULL REFERENCES public.knowledge_releases(version),
    stream_name text NOT NULL,
    record_id text NOT NULL,
    attempts integer NOT NULL CHECK (attempts > 0),
    error_code text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (release_version, stream_name, record_id)
);

CREATE OR REPLACE VIEW public.current_business_faq AS
SELECT c.*
FROM public.business_faq_cards c
JOIN public.knowledge_releases r ON r.version = c.release_version
WHERE r.status = 'active';

CREATE OR REPLACE VIEW public.current_product_knowledge AS
SELECT c.*, p.sale_status_snapshot, p.recommendable_snapshot
FROM public.workbench_product_chunks c
JOIN public.workbench_products p
    ON p.product_id = c.product_id
    AND p.release_version = c.release_version
JOIN public.knowledge_releases r ON r.version = c.release_version
WHERE r.status = 'active';
CREATE TABLE IF NOT EXISTS public.workbench_users (
    id uuid PRIMARY KEY,
    username text NOT NULL UNIQUE CHECK (btrim(username) <> ''),
    password_hash text NOT NULL CHECK (password_hash ~ '^[$]2[aby][$][0-9]{2}[$]'),
    role text NOT NULL CHECK (role IN ('agent', 'admin')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until timestamptz,
    must_reset_password boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.workbench_sessions (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id uuid NOT NULL REFERENCES public.workbench_users(id),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS workbench_sessions_user_expires_idx
    ON public.workbench_sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS public.draft_runs (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.workbench_users(id),
    question text NOT NULL CHECK (btrim(question) <> '' AND char_length(question) <= 2000),
    intent text NOT NULL CHECK (btrim(intent) <> ''),
    answer_mode text NOT NULL CHECK (answer_mode IN ('draft', 'insufficient', 'error')),
    ai_draft text NOT NULL CHECK (btrim(ai_draft) <> ''),
    faq_snapshot jsonb NOT NULL,
    product_snapshot jsonb NOT NULL,
    model_version text NOT NULL CHECK (btrim(model_version) <> ''),
    prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
    knowledge_version text NOT NULL CHECK (btrim(knowledge_version) <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS draft_runs_user_created_idx
    ON public.draft_runs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.feedback_records (
    id uuid PRIMARY KEY,
    draft_run_id uuid NOT NULL UNIQUE REFERENCES public.draft_runs(id),
    user_id uuid NOT NULL REFERENCES public.workbench_users(id),
    action text NOT NULL CHECK (action IN ('adopted', 'modified', 'discarded')),
    final_draft text,
    discard_reason text CHECK (
        discard_reason IS NULL OR discard_reason IN (
            'knowledge_incorrect',
            'question_unresolved',
            'wrong_product',
            'irrelevant_answer',
            'tone_or_style',
            'dynamic_data_required',
            'other'
        )
    ),
    discard_note text,
    review_status text NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'queued', 'no_action')),
    reviewed_by uuid REFERENCES public.workbench_users(id),
    reviewed_at timestamptz,
    review_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (draft_run_id, user_id)
        REFERENCES public.draft_runs(id, user_id),
    CHECK (
        (
            action = 'adopted'
            AND final_draft IS NULL
            AND discard_reason IS NULL
            AND discard_note IS NULL
        )
        OR (
            action = 'modified'
            AND final_draft IS NOT NULL
            AND btrim(final_draft) <> ''
            AND discard_reason IS NULL
            AND discard_note IS NULL
        )
        OR (
            action = 'discarded'
            AND final_draft IS NULL
            AND discard_reason IS NOT NULL
            AND (discard_note IS NULL OR btrim(discard_note) <> '')
            AND (
                discard_reason <> 'other'
                OR (discard_note IS NOT NULL AND btrim(discard_note) <> '')
            )
        )
    ),
    CHECK (
        (
            review_status = 'pending'
            AND reviewed_by IS NULL
            AND reviewed_at IS NULL
        )
        OR (
            review_status IN ('queued', 'no_action')
            AND reviewed_by IS NOT NULL
            AND reviewed_at IS NOT NULL
        )
    )
);

CREATE INDEX IF NOT EXISTS feedback_records_user_created_idx
    ON public.feedback_records (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.review_items (
    id uuid PRIMARY KEY,
    feedback_id uuid NOT NULL UNIQUE REFERENCES public.feedback_records(id),
    category text NOT NULL CHECK (
        category IN ('knowledge', 'product', 'retrieval', 'prompt', 'dynamic_data', 'other')
    ),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_review', 'resolved', 'no_action')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
