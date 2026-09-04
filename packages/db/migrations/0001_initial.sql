CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE match_state AS ENUM ('DRAFT', 'LOBBY', 'HIDING', 'ACTIVE', 'PAUSED', 'FINISHED', 'CANCELED');
CREATE TYPE player_role AS ENUM ('HOST', 'HIDER', 'SEEKER', 'SPECTATOR');
CREATE TYPE participant_status AS ENUM ('ACTIVE', 'TAGGED', 'DISQUALIFIED', 'LEFT');
CREATE TYPE visibility_mode AS ENUM ('NEVER', 'ALWAYS', 'PULSE');
CREATE TYPE caught_behavior AS ENUM ('SEEKER', 'SPECTATOR');
CREATE TYPE boundary_audience AS ENUM ('HOST', 'SEEKERS', 'ALL');
CREATE TYPE session_kind AS ENUM ('TELEGRAM', 'GUEST');
CREATE TYPE location_source AS ENUM ('BROWSER', 'TELEGRAM');

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id bigint NOT NULL UNIQUE,
  username varchar(64),
  first_name varchar(128) NOT NULL,
  last_name varchar(128),
  photo_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  telegram_chat_id bigint,
  name varchar(80) NOT NULL,
  state match_state NOT NULL DEFAULT 'DRAFT',
  state_before_pause match_state,
  winner_role player_role,
  phase_started_at timestamptz,
  phase_ends_at timestamptz,
  active_started_at timestamptz,
  paused_at timestamptz,
  paused_duration_ms bigint NOT NULL DEFAULT 0,
  emergency_reveal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT winner_role_valid CHECK (winner_role IS NULL OR winner_role IN ('HIDER', 'SEEKER'))
);
CREATE INDEX matches_host_idx ON matches(host_account_id);
CREATE INDEX matches_state_idx ON matches(state);

CREATE TABLE telegram_chat_ownerships (
  telegram_chat_id bigint NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_chat_id, account_id)
);
CREATE INDEX telegram_chat_ownerships_account_idx ON telegram_chat_ownerships(account_id);

CREATE TABLE match_settings (
  match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  duration_seconds integer NOT NULL DEFAULT 3600 CHECK (duration_seconds BETWEEN 60 AND 86400),
  hide_seconds integer NOT NULL DEFAULT 300 CHECK (hide_seconds BETWEEN 0 AND 7200),
  tap_tag_enabled boolean NOT NULL DEFAULT true,
  auto_tag_enabled boolean NOT NULL DEFAULT false,
  tag_radius_meters double precision NOT NULL DEFAULT 15 CHECK (tag_radius_meters BETWEEN 2 AND 100),
  auto_tag_dwell_seconds integer NOT NULL DEFAULT 5 CHECK (auto_tag_dwell_seconds BETWEEN 1 AND 120),
  tag_cooldown_seconds integer NOT NULL DEFAULT 5 CHECK (tag_cooldown_seconds BETWEEN 0 AND 300),
  position_max_age_seconds integer NOT NULL DEFAULT 15 CHECK (position_max_age_seconds BETWEEN 2 AND 120),
  max_accuracy_meters double precision NOT NULL DEFAULT 50 CHECK (max_accuracy_meters BETWEEN 5 AND 500),
  max_speed_mps double precision NOT NULL DEFAULT 15 CHECK (max_speed_mps BETWEEN 1 AND 100),
  caught_behavior caught_behavior NOT NULL DEFAULT 'SPECTATOR',
  boundary_grace_seconds integer NOT NULL DEFAULT 30 CHECK (boundary_grace_seconds BETWEEN 0 AND 1800),
  boundary_audience boundary_audience NOT NULL DEFAULT 'HOST',
  boundary_disqualify boolean NOT NULL DEFAULT false,
  CONSTRAINT tag_mode_enabled CHECK (tap_tag_enabled OR auto_tag_enabled)
);

CREATE TABLE visibility_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  observer_role player_role NOT NULL,
  target_role player_role NOT NULL,
  mode visibility_mode NOT NULL,
  visible_duration_seconds integer NOT NULL DEFAULT 10 CHECK (visible_duration_seconds BETWEEN 1 AND 3600),
  cycle_period_seconds integer NOT NULL DEFAULT 60 CHECK (cycle_period_seconds BETWEEN 2 AND 86400),
  phase_offset_seconds integer NOT NULL DEFAULT 0 CHECK (phase_offset_seconds BETWEEN 0 AND 86400),
  persist_last_seen boolean NOT NULL DEFAULT true,
  UNIQUE(match_id, observer_role, target_role),
  CONSTRAINT pulse_duration_valid CHECK (mode <> 'PULSE' OR visible_duration_seconds < cycle_period_seconds)
);

CREATE TABLE playzones (
  match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  polygon geometry(Polygon, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playzone_valid CHECK (ST_IsValid(polygon) AND NOT ST_IsEmpty(polygon))
);
CREATE INDEX playzones_polygon_gist_idx ON playzones USING gist(polygon);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  display_name varchar(40) NOT NULL,
  role player_role NOT NULL DEFAULT 'SPECTATOR',
  status participant_status NOT NULL DEFAULT 'ACTIVE',
  consent_location_at timestamptz,
  consent_replay_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  tagged_at timestamptz,
  UNIQUE(match_id, account_id)
);
CREATE INDEX participants_match_idx ON participants(match_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  code_hash varchar(64) NOT NULL UNIQUE,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_match_idx ON invitations(match_id);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash varchar(64) NOT NULL UNIQUE,
  kind session_kind NOT NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  participant_id uuid REFERENCES participants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_identity_valid CHECK (
    (kind = 'TELEGRAM' AND account_id IS NOT NULL) OR
    (kind = 'GUEST' AND participant_id IS NOT NULL)
  )
);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE latest_locations (
  participant_id uuid PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  point geography(Point, 4326) NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  accuracy_meters double precision NOT NULL CHECK (accuracy_meters > 0),
  speed_mps double precision,
  heading_degrees double precision,
  source location_source NOT NULL,
  client_sequence bigint NOT NULL
);
CREATE INDEX latest_locations_match_idx ON latest_locations(match_id);
CREATE INDEX latest_locations_point_gist_idx ON latest_locations USING gist(point);

CREATE TABLE location_samples (
  id bigserial NOT NULL,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  point geography(Point, 4326) NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  accuracy_meters double precision NOT NULL CHECK (accuracy_meters > 0),
  speed_mps double precision,
  heading_degrees double precision,
  source location_source NOT NULL,
  client_sequence bigint NOT NULL,
  PRIMARY KEY(id, recorded_at)
) PARTITION BY RANGE(recorded_at);

CREATE OR REPLACE FUNCTION ensure_location_sample_partitions(months_ahead integer DEFAULT 24)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  start_month date := (date_trunc('month', current_date) - interval '1 month')::date;
  partition_start date;
  partition_end date;
  partition_name text;
  i integer;
BEGIN
  FOR i IN 0..months_ahead LOOP
    partition_start := (start_month + make_interval(months => i))::date;
    partition_end := (partition_start + interval '1 month')::date;
    partition_name := 'location_samples_' || to_char(partition_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF location_samples FOR VALUES FROM (%L) TO (%L)',
      partition_name, partition_start, partition_end
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(match_id, participant_id, recorded_at)', partition_name || '_replay_idx', partition_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING gist(point)', partition_name || '_point_gist_idx', partition_name);
  END LOOP;
END;
$$;

SELECT ensure_location_sample_partitions(60);

CREATE TABLE game_events (
  id bigserial PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  type varchar(64) NOT NULL,
  actor_participant_id uuid REFERENCES participants(id) ON DELETE SET NULL,
  target_participant_id uuid REFERENCES participants(id) ON DELETE SET NULL,
  point geography(Point, 4326),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX game_events_match_time_idx ON game_events(match_id, occurred_at);

CREATE TABLE boundary_states (
  participant_id uuid PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  outside_since timestamptz,
  grace_ends_at timestamptz,
  action_applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE replay_publications (
  match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  published_at timestamptz NOT NULL,
  published_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER matches_set_updated_at BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER playzones_set_updated_at BEFORE UPDATE ON playzones FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT USAGE ON SCHEMA public TO geohunter_app, geohunter_mcp;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO geohunter_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO geohunter_app;
GRANT EXECUTE ON FUNCTION ensure_location_sample_partitions(integer) TO geohunter_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO geohunter_mcp;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO geohunter_mcp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO geohunter_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO geohunter_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO geohunter_mcp;
