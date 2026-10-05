/**
 * Product database schema. Offchain state only: users, targets, circles, rounds, intents, approvals, residual decisions
 * and activity. Balances, prices and settlements are always re-read from BNB Chain. Ported from Venue0 (001-004 folded
 * into one migration) plus the Sama additions. Each entry runs once, in order, and is recorded in schema_migrations.
 */
export const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: "001_sama",
    sql: `
create table users (
  address text primary key,
  privy_user_id text,
  email text,
  wallet_kind text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  residual_style text not null default 'ECONOMIC',
  cost_cap_bps integer not null default 100,
  notify_email boolean not null default true,
  notify_telegram boolean not null default false,
  notify_in_app boolean not null default true,
  locale text
);

create table targets (
  address text primary key references users(address),
  weights jsonb not null,
  source text not null,
  instruction text,
  updated_at timestamptz not null default now()
);

create table circles (
  id text primary key,
  name text not null,
  description text not null default '',
  visibility text not null,
  organizer text not null references users(address),
  asset_uids jsonb not null,
  min_participants integer not null,
  cadence_sec integer,
  duration_sec integer not null,
  residual_behavior text not null,
  privacy_mode text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  circle_id text not null references circles(id),
  address text not null references users(address),
  role text not null,
  joined_at timestamptz not null default now(),
  primary key (circle_id, address)
);

create table invites (
  code_hash text primary key,
  circle_id text not null references circles(id),
  created_by text not null,
  created_at timestamptz not null default now(),
  used_by text,
  used_at timestamptz
);

create table rounds (
  id text primary key,
  circle_id text not null references circles(id),
  sequence integer not null,
  state text not null,
  opens_at bigint not null,
  freezes_at bigint not null,
  chain_id integer not null,
  settlement_contract text not null,
  snapshot jsonb not null,
  snapshot_hash text not null,
  snapshot_block text not null,
  snapshot_meta jsonb not null,
  match jsonb,
  plan jsonb,
  settlement_tx text,
  verification jsonb,
  created_at timestamptz not null default now(),
  unique (circle_id, sequence)
);

create table round_history (
  id bigserial primary key,
  round_id text not null references rounds(id),
  at bigint not null,
  from_state text not null,
  to_state text not null,
  reason text
);

create table intents (
  round_id text not null references rounds(id),
  owner text not null references users(address),
  intent jsonb not null,
  signature text not null,
  intent_hash text not null,
  submitted_at timestamptz not null default now(),
  primary key (round_id, owner)
);

create table approvals (
  round_id text not null references rounds(id),
  participant text not null,
  nonce text not null,
  signature text not null,
  approved_at timestamptz not null default now(),
  primary key (round_id, participant)
);

create table residual_decisions (
  round_id text not null references rounds(id),
  owner text not null,
  asset_uid text not null,
  side text not null,
  amount_raw text not null,
  engine_decision text not null,
  user_choice text not null,
  detail jsonb not null,
  decided_at timestamptz not null default now(),
  consumed_round_id text,
  primary key (round_id, owner, asset_uid)
);

create table residual_quotes (
  round_id text not null references rounds(id),
  owner text not null,
  quote jsonb not null,
  created_at timestamptz not null default now(),
  primary key (round_id, owner)
);

create table activity (
  id bigserial primary key,
  address text not null,
  kind text not null,
  round_id text,
  circle_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table portfolio_snapshots (
  address text not null,
  at timestamptz not null default now(),
  total_usd double precision not null,
  primary key (address, at)
);

create table asset_checks (
  symbol text not null,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  detail jsonb not null,
  primary key (symbol, checked_at)
);

create index activity_by_address on activity(address, created_at desc);
create index rounds_by_circle on rounds(circle_id, sequence desc);
create index rounds_by_state on rounds(state);
create index snapshots_by_address on portfolio_snapshots(address, at desc);
`,
  },
  {
    // Hosted Postgres (Supabase) exposes the public schema through a REST API. Row-level security with no policies
    // denies those API roles every row; the app connects as the owning role, which RLS does not restrict.
    id: "002_lock_public_api",
    sql: `
alter table users enable row level security;
alter table targets enable row level security;
alter table circles enable row level security;
alter table memberships enable row level security;
alter table invites enable row level security;
alter table rounds enable row level security;
alter table round_history enable row level security;
alter table intents enable row level security;
alter table approvals enable row level security;
alter table residual_decisions enable row level security;
alter table residual_quotes enable row level security;
alter table activity enable row level security;
alter table portfolio_snapshots enable row level security;
alter table asset_checks enable row level security;
alter table schema_migrations enable row level security;
`,
  },
];
