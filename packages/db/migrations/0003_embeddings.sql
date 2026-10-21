-- M4: meaning-based search. Cached sentence vectors, keyed by the embedding model AND its version, so a different model never
-- reuses old vectors and the same text always finds the same vector (replays need no model).

-- One row per (transcript, model): the passages (sentence-sized windows of the transcript) and their unit vectors.
create table passage_embeddings (
  transcript_key text not null,
  model_id       text not null,
  passages       jsonb not null,
  vectors        jsonb not null,
  created_at     timestamptz not null default now(),
  primary key (transcript_key, model_id)
);

-- One row per (model, normalized query): the vector of an instruction's topic, so a repeated query needs no model call.
create table query_embeddings (
  model_id   text not null,
  query      text not null,
  vector     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (model_id, query)
);
