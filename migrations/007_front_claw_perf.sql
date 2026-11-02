CREATE SCHEMA IF NOT EXISTS front_claw_perf;

CREATE TABLE IF NOT EXISTS front_claw_perf.performance_people (
  person_id text PRIMARY KEY,
  account_id text NOT NULL UNIQUE,
  member_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  store_id text NOT NULL,
  store_name text NOT NULL,
  tier text NOT NULL,
  roles_json text NOT NULL,
  active boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS front_claw_perf.performance_aliases (
  store_id text NOT NULL,
  alias text NOT NULL,
  person_id text NOT NULL,
  PRIMARY KEY (store_id, alias)
);

CREATE TABLE IF NOT EXISTS front_claw_perf.performance_entries (
  entry_id text PRIMARY KEY,
  store_id text NOT NULL,
  business_day text NOT NULL,
  customer_name text,
  amount integer NOT NULL,
  amount_type text NOT NULL,
  owner_person_id text NOT NULL,
  owner_name text NOT NULL,
  reporter_person_id text NOT NULL,
  note text NOT NULL,
  status text NOT NULL,
  disputed boolean NOT NULL,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS performance_entries_reporter_idx
  ON front_claw_perf.performance_entries (reporter_person_id, business_day, store_id);

CREATE TABLE IF NOT EXISTS front_claw_perf.performance_revisions (
  revision_id text PRIMARY KEY,
  entry_id text NOT NULL,
  editor_person_id text NOT NULL,
  before_json text NOT NULL,
  after_json text NOT NULL,
  reason text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS front_claw_perf.performance_targets (
  store_id text NOT NULL,
  person_id text NOT NULL,
  period_month text NOT NULL,
  amount integer NOT NULL,
  updated_by text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (store_id, person_id, period_month)
);

CREATE TABLE IF NOT EXISTS front_claw_perf.performance_drafts (
  draft_id text PRIMARY KEY,
  reporter_person_id text NOT NULL,
  store_id text NOT NULL,
  business_day text NOT NULL,
  expires_at text NOT NULL,
  kind text NOT NULL,
  payload_json text NOT NULL,
  status text NOT NULL,
  reminder text NOT NULL,
  void_notice text NOT NULL,
  created_at text NOT NULL,
  closed_at text
);

CREATE TABLE IF NOT EXISTS front_claw_perf.performance_appointments (
  appointment_id text PRIMARY KEY,
  store_id text NOT NULL,
  employee_person_id text NOT NULL,
  customer_name text NOT NULL,
  when_text text NOT NULL,
  note text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS front_claw_perf.performance_notifications (
  notification_id text PRIMARY KEY,
  kind text NOT NULL,
  recipient_person_id text NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  related_id text NOT NULL,
  created_at text NOT NULL,
  sent_at text
);

CREATE TABLE IF NOT EXISTS front_claw_perf.performance_config (
  key text PRIMARY KEY,
  value text NOT NULL
);
