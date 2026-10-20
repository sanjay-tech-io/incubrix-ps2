-- First schema. Mirrors CLAUDE.md: source never modified (sha256 stored), append-only operation
-- log, separate conversation log, idempotency keys, API-facing jobs, LLM response cache.
-- IDs are text assigned by the application (no random UUIDs in anything that feeds the timeline hash).

create table sessions (
  id            text primary key,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  status        text not null default 'created'
                check (status in ('created','ingesting','transcribing','ready','failed')),
  fps_num       int  check (fps_num > 0),
  fps_den       int  check (fps_den > 0),
  duration_us   bigint check (duration_us >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index sessions_source_sha256_idx on sessions(source_sha256);

create table source_assets (
  id          text primary key,
  session_id  text not null references sessions(id) on delete cascade,
  role        text not null check (role in ('source','audio','transcript','render','export')),
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text not null,
  size_bytes  bigint not null check (size_bytes >= 0),
  mime_type   text,
  rights      text,            -- licence / consent note, mirrors SOURCES.md
  ai_generated boolean not null default false,
  created_at  timestamptz not null default now()
);
create index source_assets_session_idx on source_assets(session_id);

-- Append-only: one row per operation. group_no is the undo group (one instruction = one group).
-- op stores resolved atom-ID ranges, never seconds.
create table operation_log (
  session_id text not null references sessions(id) on delete cascade,
  seq        int  not null check (seq > 0),
  group_no   int  not null check (group_no > 0),
  kind       text not null,
  op         jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, seq)
);
create function operation_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'operation_log is append-only (% rejected)', tg_op;
end $$;
create trigger operation_log_no_update_delete
  before update or delete on operation_log
  for each row execute function operation_log_append_only();

-- Text of every turn, including clarification turns, which do not change the timeline hash.
create table conversation_log (
  session_id       text not null references sessions(id) on delete cascade,
  turn             int  not null check (turn > 0),
  instruction      text not null,
  status           text not null check (status in ('applied','needs_clarification','rejected')),
  answer           jsonb not null,
  pending_question jsonb,
  created_at       timestamptz not null default now(),
  primary key (session_id, turn)
);

-- Same key + same request_hash replays response; same key + different hash => 409.
create table idempotency_keys (
  scope         text not null,        -- e.g. 'POST /api/v1/sessions'
  key           text not null,
  request_hash  text not null,
  status_code   int,
  response      jsonb,
  created_at    timestamptz not null default now(),
  primary key (scope, key)
);

create table jobs (
  id           text primary key,
  session_id   text references sessions(id) on delete cascade,
  type         text not null check (type in ('ingest','transcribe','render','export')),
  status       text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  progress     int  not null default 0 check (progress between 0 and 100),
  result       jsonb,
  error        jsonb,
  callback_url text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index jobs_session_idx on jobs(session_id);
create index jobs_status_idx on jobs(status);

-- cache_key = sha256 of (model, prompt, relevant state); temperature is 0 so replay is valid.
create table llm_cache (
  cache_key  text primary key,
  provider   text not null,
  model      text not null,
  response   jsonb not null,
  created_at timestamptz not null default now()
);
