-- M2: what the API needs beyond the first schema. Nothing here changes the meaning of an existing column.

-- An uploaded or downloaded original. The file itself lives in S3 (storage_key) and is never modified.
create table videos (
  id           text primary key,
  sha256       text check (sha256 ~ '^[0-9a-f]{64}$'),   -- null until the bytes are stored (URL downloads)
  source_url   text,
  storage_key  text,
  filename     text,
  mime_type    text,
  size_bytes   bigint check (size_bytes >= 0),
  status       text not null default 'processing' check (status in ('processing','ready','failed')),
  probe        jsonb,                                     -- duration, exact fps, audio present, VFR
  warnings     jsonb not null default '[]',
  num_speakers_hint int check (num_speakers_hint >= 1),
  transcript_key text,                                    -- transcripts.cache_key used by this video
  rights       text,
  ai_generated boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index videos_sha256_idx on videos(sha256);

-- Words + atoms for one (file, ASR, diarization, silence/clamp settings) combination.
-- cache_key = sha256 of those inputs (computed in packages/store), NOT the file hash alone:
-- a different model or speaker hint must never reuse an old transcript.
create table transcripts (
  cache_key     text primary key check (cache_key ~ '^[0-9a-f]{64}$'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  settings      jsonb not null,
  atoms         jsonb not null,
  manifest      jsonb not null,
  created_at    timestamptz not null default now()
);
create index transcripts_source_idx on transcripts(source_sha256);

-- An intake job belongs to a video (no session exists yet).
alter table jobs add column video_id text references videos(id) on delete cascade;
alter table jobs add column request jsonb;
create index jobs_video_idx on jobs(video_id);

alter table sessions add column video_id text references videos(id);

-- Undo/redo markers are log rows without an operation: group_no 0 and op '{}'.
-- Edits keep group_no > 0. The log stays append-only (the trigger from 0001 is untouched).
alter table operation_log drop constraint operation_log_group_no_check;
alter table operation_log add constraint operation_log_group_kind_check
  check ((kind in ('undo','redo') and group_no = 0) or (kind not in ('undo','redo') and group_no > 0));
