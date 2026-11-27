-- Целевая добавка закрытого модуля Collaboration для 3.5.
-- PostgreSQL / uuid7.bigint.v.on. Применить после collaboration.sql в выбранной схеме.
BEGIN;

ALTER TABLE v_collaboration_heads
    ADD COLUMN profile varchar(32) NOT NULL DEFAULT 'standard' CHECK (profile IN ('standard', 'strict')),
    ADD COLUMN owner_fence bigint NOT NULL DEFAULT 0 CHECK (owner_fence >= 0),
    ADD COLUMN owner_id uuid,
    ADD COLUMN owner_expires_at timestamptz,
    ADD CONSTRAINT v_collaboration_heads_owner_shape CHECK (
        (owner_id IS NULL AND owner_expires_at IS NULL)
        OR (owner_id IS NOT NULL AND owner_expires_at IS NOT NULL AND owner_fence > 0)
    );

CREATE TABLE v_collaboration_client_ids (
    document_id uuid NOT NULL REFERENCES v_documents(id) ON DELETE CASCADE,
    generation bigint NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    client_id bigint NOT NULL CHECK (client_id BETWEEN 1 AND 4294967295),
    tenant_id bigint NOT NULL,
    writer_kind varchar(16) NOT NULL CHECK (writer_kind IN ('browser', 'server', 'historical')),
    effective_subject varchar(255) COLLATE "C",
    session_id uuid,
    issued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (document_id, generation, client_id),
    CHECK ((writer_kind = 'historical' AND effective_subject IS NULL)
        OR (writer_kind IN ('browser', 'server') AND effective_subject IS NOT NULL AND octet_length(effective_subject) BETWEEN 1 AND 255))
);
CREATE INDEX v_collaboration_client_ids_session
    ON v_collaboration_client_ids (document_id, generation, session_id) WHERE session_id IS NOT NULL;

CREATE TABLE v_collaboration_commands (
    id uuid PRIMARY KEY,
    tenant_id bigint NOT NULL,
    project_scope varchar(255) COLLATE "C" NOT NULL CHECK (octet_length(project_scope) BETWEEN 1 AND 255),
    effective_subject varchar(255) COLLATE "C" NOT NULL CHECK (octet_length(effective_subject) BETWEEN 1 AND 255),
    resource_id uuid NOT NULL,
    document_id uuid REFERENCES v_documents(id) ON DELETE SET NULL,
    command_id varchar(255) COLLATE "C" NOT NULL CHECK (octet_length(command_id) BETWEEN 1 AND 255),
    proposal_id uuid NOT NULL,
    proposal_digest bytea NOT NULL CHECK (octet_length(proposal_digest) = 32),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    generation bigint NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    read_position bigint NOT NULL CHECK (read_position BETWEEN 0 AND 9007199254740991),
    intent jsonb CHECK (jsonb_typeof(intent) = 'object'),
    state varchar(16) NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'committed', 'rejected')),
    owner_fence bigint CHECK (owner_fence > 0),
    base_seq bigint CHECK (base_seq BETWEEN read_position AND 9007199254740991),
    from_seq bigint CHECK (from_seq > 0),
    to_seq bigint CHECK (to_seq BETWEEN 0 AND 9007199254740991),
    receipt_id uuid UNIQUE,
    evidence jsonb CHECK (jsonb_typeof(evidence) = 'object'),
    rejection_code varchar(64) CHECK (octet_length(rejection_code) BETWEEN 1 AND 64),
    registered_at timestamptz NOT NULL,
    finalized_at timestamptz,
    replay_until timestamptz NOT NULL CHECK (replay_until >= registered_at),
    evidence_expires_at timestamptz,
    redacted_at timestamptz,
    CONSTRAINT v_collaboration_commands_scope UNIQUE
        (tenant_id, project_scope, effective_subject, resource_id, command_id),
    CONSTRAINT v_collaboration_commands_times CHECK (
        (finalized_at IS NULL OR finalized_at >= registered_at)
        AND (evidence_expires_at IS NULL OR (finalized_at IS NOT NULL AND evidence_expires_at >= finalized_at))
        AND (redacted_at IS NULL OR (finalized_at IS NOT NULL AND redacted_at >= finalized_at))
    ),
    CONSTRAINT v_collaboration_commands_shape CHECK (
        (state = 'running' AND intent IS NOT NULL AND owner_fence IS NULL
         AND finalized_at IS NULL AND base_seq IS NULL AND from_seq IS NULL AND to_seq IS NULL
         AND receipt_id IS NULL AND evidence IS NULL AND evidence_expires_at IS NULL
         AND rejection_code IS NULL AND redacted_at IS NULL)
        OR
        (state = 'committed' AND finalized_at IS NOT NULL AND receipt_id IS NOT NULL
         AND owner_fence IS NOT NULL AND base_seq IS NOT NULL AND to_seq IS NOT NULL
         AND rejection_code IS NULL AND evidence_expires_at IS NOT NULL
         AND ((from_seq IS NULL AND to_seq = base_seq)
              OR (from_seq IS NOT NULL AND from_seq = base_seq + 1 AND to_seq >= from_seq))
         AND ((evidence IS NOT NULL AND redacted_at IS NULL)
              OR (evidence IS NULL AND redacted_at IS NOT NULL AND redacted_at >= evidence_expires_at)))
        OR
        (state = 'rejected' AND finalized_at IS NOT NULL AND rejection_code IS NOT NULL
         AND receipt_id IS NULL AND from_seq IS NULL AND to_seq IS NULL
         AND evidence IS NULL AND evidence_expires_at IS NULL)
    )
);

CREATE INDEX v_collaboration_commands_pending
    ON v_collaboration_commands (document_id, generation, registered_at, id) WHERE state = 'running';
CREATE INDEX v_collaboration_commands_doc_fk
    ON v_collaboration_commands (document_id);
CREATE INDEX v_collaboration_commands_expiring
    ON v_collaboration_commands (evidence_expires_at, id)
    WHERE state = 'committed' AND redacted_at IS NULL;

-- head_seq выдаёт ровно один интервал [base_seq+1, to_seq] под FOR UPDATE.
-- Индекс ловит повторную выдачу первой позиции. Операция без новых байтов имеет from_seq IS NULL.
CREATE UNIQUE INDEX v_collaboration_commands_first_seq
    ON v_collaboration_commands (resource_id, generation, from_seq) WHERE from_seq IS NOT NULL;

-- CommandJournal применяет bytes + CAS головы + transition running→terminal + outbox в одной транзакции.
-- Завершение требует state='running', актуальные права, live lease по времени БД и owner_fence.
-- Полностью удалять ключ после истечения replay_until нельзя: оставшаяся строка различает 410 и новый ключ.
COMMIT;
