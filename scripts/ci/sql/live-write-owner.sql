-- PostgreSQL 18. Применяется после core, media, drive, documents, collaboration и collaboration-agent
-- в ВРЕМЕННОЙ базе проверки (`scripts/collab-e2e.sh`). Не является миграцией продукта.
--
-- BOUNDARY: функции ниже заменяют проектируемые PHP-классы 3.5 `RoomOwnership`, `CommandJournal` и
-- переиспользование `UpdateLog::append` (vaulter owner implementation, раздел 3.5). Порт, через
-- который Node-сторона к ним обращается, — `OwnerPort` образца live-write.
-- Физические таблицы — целевые: v_documents, v_document_sync_states, v_collaboration_heads/updates/receipts,
-- v_collaboration_commands, v_outbox. Порядок блокировок как у Vaulter: строка v_documents, затем голова
-- поколения, затем строка команды. Время аренды — clock_timestamp() базы. Каждая функция вызывается
-- отдельным psql-процессом и потому выполняется отдельной транзакцией отдельного соединения.
-- Проверка прав пользователя (Edit/Read) здесь не моделируется: её доказывают 2.x и 3.3.
BEGIN;

CREATE SCHEMA live_write_owner;

CREATE FUNCTION live_write_owner.b64(bytes bytea) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT translate(encode(bytes, 'base64'), E'\n', '') $$;

-- Документ в journal на позиции head с бинарным checkpoint на той же позиции.
CREATE FUNCTION live_write_owner.setup(doc uuid, node uuid, drive uuid, gen bigint, head bigint, fence bigint,
                                       checkpoint bytea) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO v_drives(id, profile, tenant_id, owner_id, owner_type, name)
        VALUES (drive, drive::text, 7, 9, 'user', 'live-write');
    INSERT INTO v_nodes(id, tenant_id, drive_id, kind, name, name_key)
        VALUES (node, 7, drive, 'document', 'contract-17', 'contract-17');
    INSERT INTO v_documents(id, tenant_id, node_id, type, schema_version, write_mode, collab_epoch, state_version)
        VALUES (doc, 7, node, 'vaulter/rich-text', 1, 'journal', gen, head);
    INSERT INTO v_document_sync_states(document_id, collab_protocol, collab_state_format, collab_state, collab_state_size)
        VALUES (doc, 'yjs', 'yjs', checkpoint, octet_length(checkpoint));
    INSERT INTO v_collaboration_heads(document_id, generation, head_seq, checkpoint_seq, owner_fence)
        VALUES (doc, gen, head, head, fence);
END
$$;

-- Захватить строку документа и голову текущего поколения; NULL, если вызывающий не действующий писатель.
CREATE FUNCTION live_write_owner.writer_head(doc uuid, owner uuid, fence bigint) RETURNS v_collaboration_heads
LANGUAGE plpgsql AS $$
DECLARE
    d v_documents%ROWTYPE;
    h v_collaboration_heads%ROWTYPE;
BEGIN
    SELECT * INTO d FROM v_documents WHERE id = doc FOR UPDATE;
    IF NOT FOUND OR d.write_mode <> 'journal' THEN RETURN NULL; END IF;
    SELECT * INTO h FROM v_collaboration_heads
        WHERE document_id = doc AND generation = d.collab_epoch AND retired_at IS NULL FOR UPDATE;
    IF NOT FOUND OR h.owner_id IS DISTINCT FROM owner OR h.owner_fence <> fence
       OR h.owner_expires_at <= clock_timestamp() THEN
        RETURN NULL;
    END IF;
    RETURN h;
END
$$;

-- Новая аренда писателя комнаты. Свободная или истёкшая аренда всегда получает следующий fence.
CREATE FUNCTION live_write_owner.acquire(doc uuid, owner uuid, ttl_ms integer) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    d v_documents%ROWTYPE;
    h v_collaboration_heads%ROWTYPE;
BEGIN
    SELECT * INTO d FROM v_documents WHERE id = doc FOR UPDATE;
    IF NOT FOUND OR d.write_mode <> 'journal' THEN RETURN jsonb_build_object('error', 'not_journal'); END IF;
    SELECT * INTO h FROM v_collaboration_heads
        WHERE document_id = doc AND generation = d.collab_epoch AND retired_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'generation_closed'); END IF;
    IF h.owner_id IS NOT NULL AND h.owner_expires_at > clock_timestamp() THEN
        RETURN jsonb_build_object('error', 'held', 'retry_after_ms',
            ceil(extract(epoch FROM h.owner_expires_at - clock_timestamp()) * 1000)::integer);
    END IF;
    UPDATE v_collaboration_heads
        SET owner_fence = owner_fence + 1, owner_id = owner,
            owner_expires_at = clock_timestamp() + make_interval(secs => ttl_ms / 1000.0)
        WHERE document_id = doc AND generation = h.generation
        RETURNING * INTO h;
    RETURN jsonb_build_object('fence', h.owner_fence, 'generation', h.generation, 'head_seq', h.head_seq);
END
$$;

CREATE FUNCTION live_write_owner.release(doc uuid, owner uuid, fence bigint) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
    h v_collaboration_heads;
BEGIN
    h := live_write_owner.writer_head(doc, owner, fence);
    IF h.document_id IS NULL THEN RETURN false; END IF;
    UPDATE v_collaboration_heads SET owner_id = NULL, owner_expires_at = NULL
        WHERE document_id = doc AND generation = h.generation;
    RETURN true;
END
$$;

-- Записать очередное подтверждённое обновление на текущей голове (вызывать под захваченной головой).
CREATE FUNCTION live_write_owner.put_update(h v_collaboration_heads, upd_id text, payload bytea, digest text)
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    next_seq bigint := h.head_seq + 1;
BEGIN
    INSERT INTO v_collaboration_updates(document_id, generation, seq, update_id, payload, sha256, created_at)
        VALUES (h.document_id, h.generation, next_seq, upd_id, payload, digest, CURRENT_TIMESTAMP);
    INSERT INTO v_collaboration_receipts(document_id, generation, update_id, seq, sha256, committed_at)
        VALUES (h.document_id, h.generation, upd_id, next_seq, digest, CURRENT_TIMESTAMP);
    UPDATE v_collaboration_heads SET head_seq = next_seq
        WHERE document_id = h.document_id AND generation = h.generation;
    UPDATE v_documents SET state_version = state_version + 1 WHERE id = h.document_id;
    UPDATE v_document_sync_states SET pending_protocol = 'yjs', pending_state_format = 'yjs',
        pending_schema_version = 1, pending_generation = h.generation, pending_through_seq = next_seq
        WHERE document_id = h.document_id;
    RETURN next_seq;
END
$$;

-- Обычный ввод пользователя строгой комнаты: его передаёт действующий писатель комнаты.
CREATE FUNCTION live_write_owner.append_update(doc uuid, owner uuid, fence bigint, expected_head bigint,
                                               upd_id text, payload bytea, digest text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    h v_collaboration_heads;
    known bigint;
BEGIN
    h := live_write_owner.writer_head(doc, owner, fence);
    IF h.document_id IS NULL THEN RETURN jsonb_build_object('error', 'stale_owner'); END IF;
    SELECT seq INTO known FROM v_collaboration_receipts
        WHERE document_id = doc AND generation = h.generation AND update_id = upd_id;
    IF FOUND THEN RETURN jsonb_build_object('seq', known, 'duplicate', true); END IF;
    IF encode(sha256(payload), 'hex') <> digest THEN RETURN jsonb_build_object('error', 'hash_mismatch'); END IF;
    IF h.head_seq <> expected_head THEN
        RETURN jsonb_build_object('error', 'base_moved', 'head_seq', h.head_seq);
    END IF;
    RETURN jsonb_build_object('seq', live_write_owner.put_update(h, upd_id, payload, digest), 'duplicate', false);
END
$$;

CREATE FUNCTION live_write_owner.command_json(c v_collaboration_commands) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'id', c.id, 'command_id', c.command_id, 'state', c.state, 'receipt_id', c.receipt_id,
        'rejection_code', c.rejection_code, 'base_seq', c.base_seq, 'from_seq', c.from_seq, 'to_seq', c.to_seq,
        'owner_fence', c.owner_fence, 'evidence', c.evidence,
        'marker', CASE WHEN c.state = 'committed'
                       THEN jsonb_build_object('generation', c.generation, 'position', c.to_seq) END)
$$;

-- Регистрация намерения. Совпавший ключ и отпечаток дают уже известный статус; другой отпечаток — конфликт.
CREATE FUNCTION live_write_owner.register_intent(doc uuid, project text, subject text, command text,
                                                 print bytea, body jsonb, read_position bigint) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    d v_documents%ROWTYPE;
    c v_collaboration_commands%ROWTYPE;
BEGIN
    SELECT * INTO STRICT d FROM v_documents WHERE id = doc;
    INSERT INTO v_collaboration_commands(id, tenant_id, project_scope, effective_subject, resource_id, document_id,
            command_id, proposal_id, proposal_digest, fingerprint, generation, schema_version, read_position,
            intent, registered_at, replay_until)
        VALUES (uuidv7(), d.tenant_id, project, subject, d.node_id, doc, command, uuidv7(),
            sha256(convert_to('consent:' || command, 'UTF8')), print, d.collab_epoch, d.schema_version,
            read_position, body, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '7 days')
        ON CONFLICT ON CONSTRAINT v_collaboration_commands_scope DO NOTHING;
    SELECT * INTO STRICT c FROM v_collaboration_commands
        WHERE tenant_id = d.tenant_id AND project_scope = project AND effective_subject = subject
          AND resource_id = d.node_id AND command_id = command;
    IF c.fingerprint <> print THEN
        RETURN jsonb_build_object('error', 'key_conflict', 'state', c.state);
    END IF;
    RETURN live_write_owner.command_json(c);
END
$$;

CREATE FUNCTION live_write_owner.status(doc uuid, project text, subject text, command text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT live_write_owner.command_json(c) FROM v_collaboration_commands c JOIN v_documents d ON d.node_id = c.resource_id
        WHERE d.id = doc AND c.tenant_id = d.tenant_id AND c.project_scope = project
          AND c.effective_subject = subject AND c.command_id = command
$$;

-- Окончательная фиксация успешной команды: точные байты, голова, квитанции, исход и outbox — одним commit.
CREATE FUNCTION live_write_owner.settle_commit(cmd uuid, owner uuid, fence bigint, base bigint,
                                               updates jsonb, proof jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    doc uuid;
    h v_collaboration_heads;
    c v_collaboration_commands%ROWTYPE;
    item jsonb;
    bytes bytea;
    last_seq bigint;
    receipt uuid := uuidv7();
BEGIN
    SELECT document_id INTO STRICT doc FROM v_collaboration_commands WHERE id = cmd;
    h := live_write_owner.writer_head(doc, owner, fence);
    SELECT * INTO STRICT c FROM v_collaboration_commands WHERE id = cmd FOR UPDATE;
    IF c.state <> 'running' THEN
        RETURN live_write_owner.command_json(c) || jsonb_build_object('duplicate', true);
    END IF;
    IF h.document_id IS NULL THEN RETURN jsonb_build_object('error', 'stale_owner'); END IF;
    IF c.generation <> h.generation THEN RETURN jsonb_build_object('error', 'generation_changed'); END IF;
    IF h.head_seq <> base THEN RETURN jsonb_build_object('error', 'base_moved', 'head_seq', h.head_seq); END IF;
    -- A command whose effect is already present commits without bytes: from_seq NULL, to_seq = base.
    last_seq := base;
    FOR item IN SELECT value FROM jsonb_array_elements(updates) LOOP
        IF encode(sha256(decode(item->>'payload', 'base64')), 'hex') <> item->>'sha256' THEN
            RETURN jsonb_build_object('error', 'hash_mismatch');
        END IF;
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(updates) LOOP
        bytes := decode(item->>'payload', 'base64');
        last_seq := live_write_owner.put_update(h, item->>'update_id', bytes, item->>'sha256');
        h.head_seq := last_seq;
    END LOOP;
    UPDATE v_collaboration_commands SET state = 'committed', owner_fence = fence, base_seq = base,
            from_seq = CASE WHEN last_seq > base THEN base + 1 END, to_seq = last_seq, receipt_id = receipt, evidence = proof,
            finalized_at = CURRENT_TIMESTAMP, evidence_expires_at = CURRENT_TIMESTAMP + interval '7 days'
        WHERE id = cmd
        RETURNING * INTO c;
    INSERT INTO v_outbox(event_id, tenant_id, scope_kind, scope_id, aggregate_type, aggregate_id, sequence, type,
            external, payload, created_at)
        VALUES ('collab-cmd-' || receipt, c.tenant_id, 'document', doc::text, 'document', doc::text, last_seq,
            'collaboration.command.committed', false,
            json_build_object('document_id', doc, 'generation', c.generation, 'from_seq', c.from_seq,
                              'to_seq', last_seq, 'command_id', c.command_id, 'receipt_id', receipt),
            CURRENT_TIMESTAMP);
    RETURN live_write_owner.command_json(c) || jsonb_build_object('duplicate', false);
END
$$;

CREATE FUNCTION live_write_owner.settle_reject(cmd uuid, owner uuid, fence bigint, code text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    doc uuid;
    h v_collaboration_heads;
    c v_collaboration_commands%ROWTYPE;
BEGIN
    SELECT document_id INTO STRICT doc FROM v_collaboration_commands WHERE id = cmd;
    h := live_write_owner.writer_head(doc, owner, fence);
    SELECT * INTO STRICT c FROM v_collaboration_commands WHERE id = cmd FOR UPDATE;
    IF c.state <> 'running' THEN
        RETURN live_write_owner.command_json(c) || jsonb_build_object('duplicate', true);
    END IF;
    IF h.document_id IS NULL THEN RETURN jsonb_build_object('error', 'stale_owner'); END IF;
    UPDATE v_collaboration_commands SET state = 'rejected', rejection_code = code, finalized_at = CURRENT_TIMESTAMP
        WHERE id = cmd RETURNING * INTO c;
    RETURN live_write_owner.command_json(c) || jsonb_build_object('duplicate', false);
END
$$;

CREATE FUNCTION live_write_owner.head(doc uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('generation', h.generation, 'head_seq', h.head_seq, 'owner_fence', h.owner_fence)
        FROM v_collaboration_heads h JOIN v_documents d ON d.id = h.document_id AND d.collab_epoch = h.generation
        WHERE h.document_id = doc AND h.retired_at IS NULL
$$;

-- Подтверждённая основа: бинарный checkpoint и непрерывный хвост (C, min(H, through)].
CREATE FUNCTION live_write_owner.load(doc uuid, after_seq bigint, through bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'generation', h.generation, 'head_seq', h.head_seq, 'checkpoint_seq', h.checkpoint_seq,
        'checkpoint', CASE WHEN after_seq IS NULL THEN live_write_owner.b64(s.collab_state) END,
        'tail', COALESCE((SELECT jsonb_agg(jsonb_build_object('seq', u.seq, 'update_id', u.update_id,
                                  'sha256', u.sha256, 'payload', live_write_owner.b64(u.payload)) ORDER BY u.seq)
                          FROM v_collaboration_updates u
                          WHERE u.document_id = doc AND u.generation = h.generation
                            AND u.seq > GREATEST(h.checkpoint_seq, COALESCE(after_seq, h.checkpoint_seq))
                            AND u.seq <= LEAST(h.head_seq, COALESCE(through, h.head_seq))), '[]'::jsonb))
    FROM v_collaboration_heads h
    JOIN v_documents d ON d.id = h.document_id AND d.collab_epoch = h.generation
    JOIN v_document_sync_states s ON s.document_id = h.document_id
    WHERE h.document_id = doc AND h.retired_at IS NULL
$$;

CREATE FUNCTION live_write_owner.outbox(doc uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('event_id', event_id, 'payload', payload::jsonb) ORDER BY outbox_seq),
                    '[]'::jsonb)
        FROM v_outbox WHERE scope_kind = 'document' AND scope_id = doc::text
$$;

-- Независимый от Y.Doc подсчёт записей.
CREATE FUNCTION live_write_owner.counts(doc uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'head_seq', (SELECT head_seq FROM v_collaboration_heads WHERE document_id = doc AND retired_at IS NULL),
        'owner_fence', (SELECT owner_fence FROM v_collaboration_heads WHERE document_id = doc AND retired_at IS NULL),
        'updates', (SELECT count(*) FROM v_collaboration_updates WHERE document_id = doc),
        'update_receipts', (SELECT count(*) FROM v_collaboration_receipts WHERE document_id = doc),
        'commands_committed', (SELECT count(*) FROM v_collaboration_commands WHERE document_id = doc AND state = 'committed'),
        'commands_running', (SELECT count(*) FROM v_collaboration_commands WHERE document_id = doc AND state = 'running'),
        'commands_rejected', (SELECT count(*) FROM v_collaboration_commands WHERE document_id = doc AND state = 'rejected'),
        'command_receipts', (SELECT count(receipt_id) FROM v_collaboration_commands WHERE document_id = doc),
        'outbox_events', (SELECT count(*) FROM v_outbox WHERE scope_kind = 'document' AND scope_id = doc::text))
$$;

COMMIT;
