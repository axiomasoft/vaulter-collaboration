-- Профиль 2.x: только core, media, drive, documents и collaboration.
-- Последовательность подтверждённых событий. Бинарный merge Yjs проверяет отдельный E2E Hub.
BEGIN;

CREATE FUNCTION pg_temp.publish_prefix(doc uuid, token text, through_seq bigint) RETURNS boolean
LANGUAGE plpgsql AS $body$
BEGIN
    PERFORM 1 FROM v_documents WHERE id=doc AND write_mode='journal' AND collab_epoch=3
        AND state_version=8 FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM 1 FROM v_collaboration_heads WHERE document_id=doc AND generation=3 FOR UPDATE;
    UPDATE v_collaboration_heads SET checkpoint_seq=through_seq, checkpoint_version=9,
        lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL, lease_through_seq=NULL
        WHERE document_id=doc AND generation=3 AND retired_at IS NULL AND lease_token=token
        AND lease_expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
        AND checkpoint_seq=40 AND checkpoint_version=8
        AND through_seq BETWEEN checkpoint_seq AND lease_through_seq;
    IF NOT FOUND THEN RETURN false; END IF;
    UPDATE v_documents SET state_version=9 WHERE id=doc;
    DELETE FROM v_collaboration_updates WHERE document_id=doc AND generation=3 AND seq <= through_seq;
    UPDATE v_document_sync_states SET pending_protocol=NULL, pending_state_format=NULL,
        pending_schema_version=NULL, pending_generation=NULL, pending_through_seq=NULL
        WHERE document_id=doc AND pending_generation=3 AND pending_through_seq <= through_seq;
    RETURN true;
END
$body$;

DO $test$
DECLARE
    drive_key uuid := uuidv7();
    node_key uuid := uuidv7();
    doc_key uuid := uuidv7();
    issued_token text := repeat('a', 64);
    violation text;
BEGIN
    INSERT INTO v_drives(id,tenant_id,owner_id,owner_type,name)
        VALUES (drive_key,17,42,'user','compaction');
    INSERT INTO v_nodes(id,tenant_id,drive_id,kind,name,name_key)
        VALUES (node_key,17,drive_key,'document','agreement','agreement');
    INSERT INTO v_documents(id,tenant_id,node_id,type,schema_version,write_mode,collab_epoch,state_version)
        VALUES (doc_key,17,node_key,'vaulter/rich-text',2,'journal',3,8);
    INSERT INTO v_document_sync_states(document_id,collab_protocol,collab_state_format,
        pending_protocol,pending_state_format,pending_schema_version,pending_generation,pending_through_seq)
        VALUES (doc_key,'yjs','yjs','yjs','yjs',2,3,41);
    INSERT INTO v_collaboration_heads(document_id,generation,head_seq,checkpoint_seq,checkpoint_version)
        VALUES (doc_key,3,41,40,8);
    INSERT INTO v_collaboration_updates(document_id,generation,seq,update_id,payload,sha256)
        VALUES (doc_key,3,41,uuidv7()::text,'41'::bytea,encode(sha256('41'::bytea),'hex'));
    BEGIN
        UPDATE v_collaboration_heads SET lease_token=issued_token, lease_owner='hub-A',
            lease_expires_at=(clock_timestamp() AT TIME ZONE 'UTC') + interval '1 minute'
            WHERE document_id=doc_key;
        RAISE EXCEPTION 'Compaction lease without a granted upper bound was accepted';
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS violation = CONSTRAINT_NAME;
        IF violation <> 'v_collaboration_heads_compaction_lease' THEN RAISE; END IF;
    END;
    UPDATE v_collaboration_heads SET lease_token=issued_token, lease_owner='hub-A',
        lease_expires_at=(clock_timestamp() AT TIME ZONE 'UTC') + interval '1 minute', lease_through_seq=head_seq
        WHERE document_id=doc_key;
    -- После выдачи материала компактору принят следующий append.
    UPDATE v_collaboration_heads SET head_seq=42 WHERE document_id=doc_key;
    UPDATE v_document_sync_states SET pending_through_seq=42 WHERE document_id=doc_key;
    INSERT INTO v_collaboration_updates(document_id,generation,seq,update_id,payload,sha256)
        VALUES (doc_key,3,42,uuidv7()::text,'42'::bytea,encode(sha256('42'::bytea),'hex'));
    IF pg_temp.publish_prefix(doc_key,issued_token,42) THEN
        RAISE EXCEPTION 'A lease covering only 41 published a checkpoint through 42';
    END IF;
    IF (SELECT count(*) FROM v_collaboration_updates WHERE document_id=doc_key) <> 2 THEN
        RAISE EXCEPTION 'A rejected checkpoint deleted part of the log';
    END IF;
    IF NOT pg_temp.publish_prefix(doc_key,issued_token,41) THEN
        RAISE EXCEPTION 'A valid checkpoint through 41 was rejected';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM v_collaboration_updates WHERE document_id=doc_key AND seq=42)
       OR EXISTS (SELECT 1 FROM v_collaboration_updates WHERE document_id=doc_key AND seq=41)
       OR NOT EXISTS (SELECT 1 FROM v_document_sync_states WHERE document_id=doc_key AND pending_through_seq=42)
       OR NOT EXISTS (SELECT 1 FROM v_collaboration_heads WHERE document_id=doc_key AND head_seq=42
           AND checkpoint_seq=41 AND lease_through_seq IS NULL) THEN
        RAISE EXCEPTION 'Checkpoint did not preserve the unmerged tail and its marker';
    END IF;
END
$test$;
ROLLBACK;
