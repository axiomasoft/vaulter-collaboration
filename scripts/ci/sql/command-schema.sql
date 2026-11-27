-- PostgreSQL 18. Запускать после целевой установки в выделенной БД.
-- Проверяет физические ограничения и последовательный CAS; интеграционные гонки требуют двух соединений и живого Hub.
BEGIN;
DO $test$
DECLARE
    drive_key uuid := uuidv7();
    node_key uuid := uuidv7();
    doc_key uuid := uuidv7();
    cmd_key uuid := uuidv7();
    first_owner uuid := uuidv7();
    second_owner uuid := uuidv7();
    command_row v_collaboration_commands%ROWTYPE;
    affected integer;
    constraint_name_text text;
BEGIN
    INSERT INTO v_drives(id, tenant_id, owner_id, owner_type, name)
        VALUES (drive_key, 17, 42, 'user', 'live-ledger');
    INSERT INTO v_nodes(id, tenant_id, drive_id, kind, name, name_key)
        VALUES (node_key, 17, drive_key, 'document', 'agreement', 'agreement');
    INSERT INTO v_documents(id, tenant_id, node_id, type, schema_version, write_mode, collab_epoch)
        VALUES (doc_key, 17, node_key, 'vaulter/rich-text', 2, 'journal', 3);
    INSERT INTO v_collaboration_heads(document_id, generation, head_seq)
        VALUES (doc_key, 3, 41);
    INSERT INTO v_collaboration_commands(id, tenant_id, project_scope, effective_subject, resource_id, document_id,
        command_id, proposal_id, proposal_digest, fingerprint, generation, schema_version, read_position,
        intent, registered_at, replay_until)
        VALUES (cmd_key, 17, 'legal', 'user/42', node_key, doc_key, 'A42', uuidv7(),
                sha256('consent'::bytea), sha256('intent'::bytea), 3, 2, 40, '{"kind":"replace"}',
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '7 days');
    SELECT * INTO STRICT command_row FROM v_collaboration_commands WHERE id = cmd_key;
    BEGIN
        command_row.id := uuidv7();
        INSERT INTO v_collaboration_commands VALUES (command_row.*);
        RAISE EXCEPTION 'Duplicate command scope accepted';
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS constraint_name_text = CONSTRAINT_NAME;
        IF constraint_name_text <> 'v_collaboration_commands_scope' THEN RAISE; END IF;
    END;
    BEGIN
        UPDATE v_collaboration_commands SET state='committed' WHERE id=cmd_key;
        RAISE EXCEPTION 'Missing receipt or invalid bounds accepted';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS constraint_name_text = CONSTRAINT_NAME;
        IF constraint_name_text <> 'v_collaboration_commands_shape' THEN RAISE; END IF;
    END;
    -- Блокировки уже удерживаются текущей тестовой транзакцией. Без handover позиция головы остаётся 41.
    UPDATE v_collaboration_heads SET owner_fence=1, owner_id=first_owner, owner_expires_at=clock_timestamp() - interval '1 second'
        WHERE document_id=doc_key AND generation=3;
    UPDATE v_collaboration_heads SET owner_expires_at=clock_timestamp() + interval '60 seconds'
        WHERE document_id=doc_key AND generation=3 AND owner_id=first_owner AND owner_fence=1
        AND owner_expires_at > clock_timestamp() AND retired_at IS NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Expired holder revived a spent fence'; END IF;
    UPDATE v_collaboration_heads SET owner_fence=owner_fence+1, owner_id=second_owner,
        owner_expires_at=clock_timestamp() + interval '60 seconds'
        WHERE document_id=doc_key AND generation=3 AND owner_expires_at <= clock_timestamp();
    UPDATE v_collaboration_heads SET owner_id=NULL, owner_expires_at=NULL
        WHERE document_id=doc_key AND generation=3 AND owner_id=first_owner AND owner_fence=1;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Stale holder released current owner'; END IF;
    UPDATE v_collaboration_commands c SET state='rejected', rejection_code='precondition_failed',
        finalized_at=CURRENT_TIMESTAMP
        FROM v_collaboration_heads h JOIN v_documents d ON d.id=h.document_id
        WHERE c.id=cmd_key AND c.state='running' AND c.document_id=h.document_id AND c.generation=h.generation
        AND d.write_mode='journal' AND d.collab_epoch=h.generation AND h.retired_at IS NULL AND h.head_seq=41
        AND h.owner_id=first_owner AND h.owner_fence=1 AND h.owner_expires_at > clock_timestamp();
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Stale holder rejected the pending command'; END IF;
    UPDATE v_collaboration_heads SET head_seq=42 WHERE document_id=doc_key AND generation=3 AND head_seq=41
        AND owner_id=first_owner AND owner_fence=1 AND owner_expires_at > clock_timestamp();
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Stale owner advanced the head'; END IF;
    UPDATE v_collaboration_heads SET head_seq=42 WHERE document_id=doc_key AND generation=3 AND head_seq=41
        AND owner_id=second_owner AND owner_fence=2 AND owner_expires_at > clock_timestamp();
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'Current owner CAS failed'; END IF;
    UPDATE v_collaboration_commands SET state='committed', owner_fence=2, base_seq=41, from_seq=42, to_seq=42,
        receipt_id=uuidv7(), evidence='{"newText":"30"}', finalized_at=CURRENT_TIMESTAMP,
        evidence_expires_at=CURRENT_TIMESTAMP + interval '7 days' WHERE id=cmd_key AND state='running';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'Command was not committed'; END IF;
    UPDATE v_collaboration_commands SET evidence='{}' WHERE id=cmd_key AND state='running';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN RAISE EXCEPTION 'Duplicate completion won'; END IF;
    BEGIN
        UPDATE v_collaboration_commands SET from_seq=40 WHERE id=cmd_key;
        RAISE EXCEPTION 'Invalid seq interval accepted';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS constraint_name_text = CONSTRAINT_NAME;
        IF constraint_name_text <> 'v_collaboration_commands_shape' THEN RAISE; END IF;
    END;
    DELETE FROM v_documents WHERE id=doc_key;
    IF NOT EXISTS(SELECT 1 FROM v_collaboration_commands
                  WHERE id=cmd_key AND resource_id=node_key AND document_id IS NULL AND state='committed') THEN
        RAISE EXCEPTION 'Owner purge lost scope tombstone';
    END IF;
END
$test$;
ROLLBACK;
