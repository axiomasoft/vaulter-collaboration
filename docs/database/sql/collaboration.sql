-- Целевая чистая установка. PostgreSQL / uuid7.bigint.v.on / public.
BEGIN;

CREATE TABLE v_collaboration_heads (
    document_id uuid NOT NULL,
    generation bigint NOT NULL DEFAULT '0'::bigint,
    protocol character varying(64) NOT NULL DEFAULT 'yjs/2'::character varying,
    head_seq bigint NOT NULL DEFAULT '0'::bigint,
    checkpoint_seq bigint NOT NULL DEFAULT '0'::bigint,
    checkpoint_version bigint NOT NULL DEFAULT '0'::bigint,
    lease_token character varying(64),
    lease_owner character varying(191),
    lease_expires_at timestamp(0) without time zone,
    lease_through_seq bigint,
    drain_requested_at timestamp(0) without time zone,
    retired_at timestamp(0) without time zone,
    created_at timestamp(0) without time zone,
    updated_at timestamp(0) without time zone,
    CONSTRAINT v_collaboration_heads_protocol_check CHECK ((protocol ~ '[^[:space:]]'::text)),
    CONSTRAINT v_collaboration_heads_checkpoint_seq_check CHECK (checkpoint_seq BETWEEN 0 AND head_seq),
    CONSTRAINT v_collaboration_heads_compaction_lease CHECK (
        (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL AND lease_through_seq IS NULL)
        OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
            AND lease_through_seq IS NOT NULL AND lease_through_seq BETWEEN checkpoint_seq AND head_seq)
    ),
    CONSTRAINT v_collaboration_heads_checkpoint_version_check CHECK ((checkpoint_version >= 0)),
    CONSTRAINT v_collaboration_heads_generation_check CHECK ((generation >= 0)),
    CONSTRAINT v_collaboration_heads_head_seq_check CHECK ((head_seq >= 0)),
    CONSTRAINT v_collaboration_heads_pkey PRIMARY KEY (document_id, generation)
);

CREATE TABLE v_collaboration_permission_versions (
    scope_key character varying(191) NOT NULL,
    version bigint NOT NULL DEFAULT '0'::bigint,
    updated_at timestamp(0) without time zone,
    CONSTRAINT v_collaboration_permission_versions_pkey PRIMARY KEY (scope_key),
    CONSTRAINT v_collaboration_permission_versions_version_check CHECK ((version >= 0))
);

CREATE TABLE v_collaboration_receipts (
    document_id uuid NOT NULL,
    generation bigint NOT NULL DEFAULT '0'::bigint,
    update_id character(36) NOT NULL,
    seq bigint NOT NULL DEFAULT '0'::bigint,
    sha256 character(64) NOT NULL,
    committed_at timestamp(0) without time zone,
    CONSTRAINT v_collaboration_receipts_generation_check CHECK ((generation >= 0)),
    CONSTRAINT v_collaboration_receipts_pkey PRIMARY KEY (document_id, generation, update_id),
    CONSTRAINT v_collaboration_receipts_seq_check CHECK ((seq >= 0))
);

CREATE TABLE v_collaboration_updates (
    document_id uuid NOT NULL,
    generation bigint NOT NULL DEFAULT '0'::bigint,
    seq bigint NOT NULL DEFAULT '0'::bigint,
    update_id character(36) NOT NULL,
    payload bytea,
    sha256 character(64) NOT NULL,
    created_at timestamp(0) without time zone,
    CONSTRAINT v_collaboration_updates_generation_check CHECK ((generation >= 0)),
    CONSTRAINT v_collaboration_updates_pkey PRIMARY KEY (document_id, generation, seq),
    CONSTRAINT v_collaboration_updates_seq_check CHECK ((seq >= 0)),
    CONSTRAINT v_collaboration_updates_update_uniq UNIQUE (document_id, generation, update_id)
);

CREATE INDEX v_collaboration_heads_document_id_index ON v_collaboration_heads USING btree (document_id);
CREATE INDEX v_collaboration_receipts_document_id_index ON v_collaboration_receipts USING btree (document_id);
CREATE INDEX v_collaboration_updates_document_id_index ON v_collaboration_updates USING btree (document_id);
ALTER TABLE v_collaboration_heads ADD CONSTRAINT v_collaboration_heads_document_fk FOREIGN KEY (document_id) REFERENCES v_documents(id) ON DELETE CASCADE;
ALTER TABLE v_collaboration_receipts ADD CONSTRAINT v_collaboration_receipts_document_fk FOREIGN KEY (document_id) REFERENCES v_documents(id) ON DELETE CASCADE;
ALTER TABLE v_collaboration_updates ADD CONSTRAINT v_collaboration_updates_document_fk FOREIGN KEY (document_id) REFERENCES v_documents(id) ON DELETE CASCADE;
COMMIT;
