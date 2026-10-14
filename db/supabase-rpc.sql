-- Requires the existing v2 schema. Does not run or change Teldrive migrations.
-- Expose ONLY teldrive_node_api in the Data API. Never grant this RPC to anon/authenticated.
BEGIN;
CREATE SCHEMA IF NOT EXISTS teldrive_node;
CREATE TABLE IF NOT EXISTS teldrive_node.records (
  bucket text NOT NULL,id text NOT NULL,owner text NOT NULL,body jsonb NOT NULL,
  PRIMARY KEY(bucket,id)
);
CREATE INDEX IF NOT EXISTS records_owner_idx ON teldrive_node.records(bucket,owner);
ALTER TABLE teldrive_node.records ENABLE ROW LEVEL SECURITY;
CREATE SCHEMA IF NOT EXISTS teldrive_node_api;
REVOKE ALL ON SCHEMA teldrive_node_api FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA teldrive_node_api TO service_role;

CREATE OR REPLACE FUNCTION teldrive_node_api.catalog(request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
<<catalog_state>>
DECLARE
  action text := request->>'action'; bucket text := request->>'bucket';
  wanted text := request->>'id'; owner_id text := request->>'owner';
  items jsonb; op jsonb; value jsonb; part jsonb; record_key text;
  old_generation bigint; old_owner bigint; changed integer; is_new boolean;
  allowed constant text[] := ARRAY['files','users','channels','bots','bot-state','sessions','session-index','keys','flows','uploads','shares','share-sessions','views','settings','tickets','idempotency','idempotency-pending','cleanup'];
BEGIN
  IF action='ready' THEN
    IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='teldrive' AND table_name='files' AND column_name='kind')
      OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='teldrive' AND table_name='files' AND column_name='normalized_name') THEN
      RAISE EXCEPTION 'unsupported_v2_schema';
    END IF;
    RETURN pg_catalog.jsonb_build_object('layout','v2','protocol',1);
  END IF;
  IF action IN ('get','list') THEN
    IF bucket IS NULL OR NOT bucket=ANY(allowed) THEN RAISE EXCEPTION 'invalid_bucket'; END IF;
    IF bucket='files' THEN
      SELECT COALESCE(pg_catalog.jsonb_agg(row),'[]'::jsonb) INTO items FROM (
        SELECT pg_catalog.to_jsonb(f) || pg_catalog.jsonb_build_object('node_meta',n.body,'stored_parts',
          (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.part_no),'[]'::jsonb) FROM teldrive.file_parts p WHERE p.file_id=f.id)) AS row
        FROM teldrive.files f LEFT JOIN teldrive_node.records n ON n.bucket='files' AND n.id=f.id::text
        WHERE (action<>'get' OR f.id::text=wanted) AND (owner_id IS NULL OR f.user_id::text=owner_id)
      ) q;
    ELSIF bucket='users' THEN
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(u) || pg_catalog.jsonb_build_object('node_meta',n.body)),'[]'::jsonb) INTO items
      FROM teldrive.users u LEFT JOIN teldrive_node.records n ON n.bucket='users' AND n.id=u.user_id::text
      WHERE action<>'get' OR u.user_id::text=wanted;
    ELSIF bucket='bots' THEN
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(b)-'session'),'[]'::jsonb) INTO items FROM teldrive.bots b
      WHERE (action<>'get' OR b.bot_id::text=wanted) AND (owner_id IS NULL OR b.user_id::text=owner_id);
    ELSIF bucket='channels' THEN
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c)),'[]'::jsonb) INTO items FROM teldrive.channels c
      WHERE (action<>'get' OR c.channel_id::text=wanted) AND (owner_id IS NULL OR c.user_id::text=owner_id);
    ELSE
      SELECT COALESCE(pg_catalog.jsonb_agg(r.body),'[]'::jsonb) INTO items FROM teldrive_node.records r
      WHERE r.bucket=catalog_state.bucket AND (action<>'get' OR r.id=wanted) AND (owner_id IS NULL OR r.owner=owner_id);
    END IF;
    RETURN pg_catalog.jsonb_build_object('items',items);
  END IF;
  IF action<>'commit' OR pg_catalog.jsonb_typeof(request->'operations')<>'array' OR pg_catalog.jsonb_array_length(request->'operations')>20000 THEN RAISE EXCEPTION 'invalid_action'; END IF;
  FOR op IN SELECT * FROM pg_catalog.jsonb_array_elements(request->'operations') LOOP
    bucket := op->>'bucket'; wanted := op->>'id'; owner_id := op->>'owner'; value := op->'value';
    IF bucket IS NULL OR NOT bucket=ANY(allowed) OR wanted IS NULL THEN RAISE EXCEPTION 'invalid_operation'; END IF;
    record_key := CASE WHEN bucket='channels' THEN owner_id||':'||wanted ELSE wanted END;
    IF op->>'action'='delete' THEN
      IF bucket='files' THEN
        DELETE FROM teldrive.files WHERE id::text=wanted AND user_id::text=owner_id AND generation=(op->>'expectedGeneration')::bigint;
        GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>1 THEN RAISE EXCEPTION 'generation_changed'; END IF;
      ELSIF bucket='bots' THEN
        IF owner_id IS NULL THEN RAISE EXCEPTION 'owner_required'; END IF;
        DELETE FROM teldrive.bots WHERE bot_id::text=wanted AND user_id::text=owner_id;
      ELSIF bucket='channels' THEN
        IF owner_id IS NULL THEN RAISE EXCEPTION 'owner_required'; END IF;
        DELETE FROM teldrive.channels WHERE channel_id::text=wanted AND user_id::text=owner_id;
      ELSIF bucket='users' THEN RAISE EXCEPTION 'user_delete_not_supported'; END IF;
      DELETE FROM teldrive_node.records r WHERE r.bucket=catalog_state.bucket AND r.id=record_key;
    ELSIF op->>'action'='put' THEN
      IF value->>'id' IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'id_mismatch'; END IF;
      IF bucket='files' THEN
        SELECT generation,user_id INTO old_generation,old_owner FROM teldrive.files WHERE id=wanted::uuid FOR UPDATE;
        is_new := NOT FOUND;
        IF NOT is_new AND (old_owner::text<>owner_id OR old_generation IS DISTINCT FROM (op->>'expectedGeneration')::bigint) THEN RAISE EXCEPTION 'generation_changed'; END IF;
        IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(COALESCE(value->'parts','[]'::jsonb)) p WHERE p->>'backend'<>'telegram' OR p->>'encryptionId' IS NOT NULL) THEN RAISE EXCEPTION 'incompatible_v2_part'; END IF;
        INSERT INTO teldrive.files AS f(id,user_id,parent_id,name,kind,mime_type,size,encryption,encryption_key_version,status,mod_time,generation,created_at,updated_at,deleted_at,hash_algorithm,hash_value)
        VALUES(wanted::uuid,owner_id::bigint,(value->>'parentId')::uuid,value->>'name',(value->>'kind')::teldrive.file_kind,value->>'mimeType',(value->>'size')::bigint,(value->>'encryption')::boolean,
          CASE WHEN (value->>'encryption')::boolean THEN (value->>'encryptionKeyVersion')::integer ELSE NULL END,(value->>'status')::teldrive.file_status,(value->>'modTime')::timestamptz,(value->>'generation')::bigint,(value->>'createdAt')::timestamptz,(value->>'updatedAt')::timestamptz,
          CASE WHEN value->>'status'='active' THEN NULL ELSE (value->>'updatedAt')::timestamptz END,value->'hash'->>'algorithm',value->'hash'->>'value')
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,status=excluded.status,mod_time=excluded.mod_time,generation=excluded.generation,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at
        WHERE f.user_id=excluded.user_id AND f.generation=(op->>'expectedGeneration')::bigint;
        GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>1 THEN RAISE EXCEPTION 'generation_changed'; END IF;
        IF is_new THEN
          FOR part IN SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(value->'parts','[]'::jsonb)) LOOP
            INSERT INTO teldrive.file_parts(file_id,part_no,channel_id,message_id,plain_size,stored_size,checksum,salt)
            VALUES(wanted::uuid,(part->>'partNo')::integer,(part->>'channelId')::bigint,(part->>'messageId')::bigint,(part->>'plainSize')::bigint,(part->>'size')::bigint,part->>'checksum',part->>'legacySalt');
          END LOOP;
        END IF;
      ELSIF bucket='users' THEN
        INSERT INTO teldrive.users(user_id,display_name,username,premium,role,disabled_at,created_at,updated_at)
        VALUES(wanted::bigint,value->>'displayName',value->>'username',(value->>'premium')::boolean,(value->>'role')::teldrive.user_role,CASE WHEN (value->>'disabled')::boolean THEN pg_catalog.now() ELSE NULL END,(value->>'createdAt')::timestamptz,(value->>'updatedAt')::timestamptz)
        ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,username=excluded.username,premium=excluded.premium,role=excluded.role,disabled_at=excluded.disabled_at,updated_at=excluded.updated_at;
      ELSIF bucket='bots' THEN
        INSERT INTO teldrive.bots AS b(bot_id,user_id,username,token_ciphertext,enabled,created_at,updated_at)
        VALUES(wanted::bigint,owner_id::bigint,value->>'username',pg_catalog.decode(value->>'tokenCiphertext','hex'),(value->>'enabled')::boolean,(value->>'createdAt')::timestamptz,pg_catalog.now())
        ON CONFLICT(bot_id) DO UPDATE SET username=excluded.username,token_ciphertext=excluded.token_ciphertext,enabled=excluded.enabled,updated_at=excluded.updated_at WHERE b.user_id=excluded.user_id;
        GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>1 THEN RAISE EXCEPTION 'bot_already_registered'; END IF;
      ELSIF bucket='channels' THEN
        INSERT INTO teldrive.channels(channel_id,user_id,name,selected,created_at,updated_at)
        VALUES(wanted::bigint,owner_id::bigint,value->>'name',(value->>'selected')::boolean,(value->>'createdAt')::timestamptz,pg_catalog.now())
        ON CONFLICT(user_id,channel_id) DO UPDATE SET name=excluded.name,selected=excluded.selected,updated_at=excluded.updated_at;
      END IF;
      INSERT INTO teldrive_node.records VALUES(bucket,record_key,COALESCE(owner_id,''),value)
      ON CONFLICT(bucket,id) DO UPDATE SET owner=excluded.owner,body=excluded.body;
    ELSE RAISE EXCEPTION 'invalid_operation'; END IF;
  END LOOP;
  RETURN '{"committed":true}'::jsonb;
END;
$$;
REVOKE ALL ON FUNCTION teldrive_node_api.catalog(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION teldrive_node_api.catalog(jsonb) TO service_role;
COMMIT;


