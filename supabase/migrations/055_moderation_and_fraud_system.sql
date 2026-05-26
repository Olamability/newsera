-- =============================================================================
-- 055_moderation_and_fraud_system.sql
--
-- Admin Moderation & Fraud Prevention System
--
-- Adds:
--   * RBAC primitives (admin_roles, role_permissions, admin_role_assignments)
--   * Append-only admin activity log with tamper-evident hash chain
--   * Reports, moderation cases & actions
--   * User suspensions and verification workflows
--   * Fraud signals and risk scores
--   * Queue priority materialized view
--   * Insert-only RLS guarantees for audit/action logs
--
-- Design notes:
--   * `admin_activity_log` and `moderation_actions` are insert-only at the
--     RLS layer (UPDATE/DELETE denied even for service role via policies and
--     row-level triggers that reject mutations).
--   * Each `admin_activity_log` row stores `row_hash = sha256(prev_hash ||
--     canonical_json(row))` so an external verifier can replay the chain.
--   * Mutations are expected to be performed via the moderation service which
--     wraps the business write + activity log insert in a single transaction.
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. RBAC
-- ---------------------------------------------------------------------------

create table if not exists public.admin_roles (
  id            text primary key,                -- e.g. 'moderator'
  display_name  text not null,
  description   text,
  created_at    timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id     text not null references public.admin_roles(id) on delete cascade,
  permission  text not null,                    -- e.g. 'reports.read', 'user.suspend.permanent'
  primary key (role_id, permission)
);

create table if not exists public.admin_role_assignments (
  user_id     uuid not null,
  role_id     text not null references public.admin_roles(id) on delete cascade,
  granted_by  uuid,
  granted_at  timestamptz not null default now(),
  primary key (user_id, role_id)
);

create index if not exists admin_role_assignments_user_idx
  on public.admin_role_assignments (user_id);

-- Seed core roles + permissions
insert into public.admin_roles (id, display_name, description) values
  ('viewer',            'Viewer',              'Read-only access to queues and analytics'),
  ('moderator',         'Moderator',           'Triage reports, hide listings, temporary suspensions'),
  ('senior_moderator',  'Senior Moderator',    'Remove listings, longer suspensions, decide appeals'),
  ('verification_reviewer', 'Verification Reviewer', 'Review identity / business verifications'),
  ('ts_lead',           'Trust & Safety Lead', 'Permanent suspensions, rule changes, role grants within T&S'),
  ('admin',             'Admin',               'Role management, audit export, system settings'),
  ('system',            'System',              'Automated actor used by fraud engine (no human login)')
on conflict (id) do nothing;

insert into public.role_permissions (role_id, permission) values
  ('viewer',               'reports.read'),
  ('viewer',               'cases.read'),
  ('viewer',               'analytics.read'),
  ('viewer',               'audit.read'),
  ('moderator',            'reports.read'),
  ('moderator',            'reports.triage'),
  ('moderator',            'cases.read'),
  ('moderator',            'cases.act'),
  ('moderator',            'listing.hide'),
  ('moderator',            'user.warn'),
  ('moderator',            'user.suspend.temp'),
  ('moderator',            'analytics.read'),
  ('senior_moderator',     'reports.read'),
  ('senior_moderator',     'cases.read'),
  ('senior_moderator',     'cases.act'),
  ('senior_moderator',     'listing.hide'),
  ('senior_moderator',     'listing.remove'),
  ('senior_moderator',     'user.suspend.temp'),
  ('senior_moderator',     'user.suspend.long'),
  ('senior_moderator',     'appeals.decide'),
  ('senior_moderator',     'analytics.read'),
  ('verification_reviewer','verifications.read'),
  ('verification_reviewer','verifications.decide'),
  ('verification_reviewer','verifications.evidence.read'),
  ('ts_lead',              'user.suspend.permanent'),
  ('ts_lead',              'fraud.rules.write'),
  ('ts_lead',              'roles.grant.ts'),
  ('ts_lead',              'analytics.read'),
  ('ts_lead',              'audit.read'),
  ('admin',                'roles.manage'),
  ('admin',                'audit.read'),
  ('admin',                'audit.export'),
  ('admin',                'settings.write'),
  ('system',               'cases.act'),
  ('system',               'listing.hide'),
  ('system',               'user.suspend.temp')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Append-only admin activity log (hash-chained)
-- ---------------------------------------------------------------------------

create table if not exists public.admin_activity_log (
  id            bigserial primary key,
  occurred_at   timestamptz not null default now(),
  request_id    uuid,
  actor_id      uuid,                    -- null for system actor
  actor_role    text,
  action        text not null,           -- e.g. 'report.assign', 'listing.hide', 'verification.evidence.view'
  target_type   text,                    -- 'report' | 'case' | 'listing' | 'user' | 'verification' | 'rule'
  target_id     text,
  before_state  jsonb,
  after_state   jsonb,
  reason_code   text,
  reason_text   text,
  metadata      jsonb not null default '{}'::jsonb,
  prev_hash     text,
  row_hash      text not null
);

create index if not exists admin_activity_log_actor_idx
  on public.admin_activity_log (actor_id, occurred_at desc);
create index if not exists admin_activity_log_target_idx
  on public.admin_activity_log (target_type, target_id, occurred_at desc);
create index if not exists admin_activity_log_action_idx
  on public.admin_activity_log (action, occurred_at desc);

-- Canonical JSON helper (stable key ordering for hashing)
create or replace function public.canonical_jsonb(input jsonb)
returns text language sql immutable as $$
  select coalesce(jsonb_path_query_first(input, '$')::text, 'null')
$$;

-- Trigger: compute hash chain on insert; reject updates/deletes
create or replace function public.admin_activity_log_hash_chain()
returns trigger language plpgsql as $$
declare
  v_prev_hash text;
  v_payload   text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'admin_activity_log is append-only (op=%)', tg_op
      using errcode = '42501';
  end if;

  select row_hash into v_prev_hash
    from public.admin_activity_log
    order by id desc
    limit 1;

  new.prev_hash := v_prev_hash;
  v_payload := coalesce(v_prev_hash, '') || '|' ||
               new.occurred_at::text || '|' ||
               coalesce(new.request_id::text, '') || '|' ||
               coalesce(new.actor_id::text, '') || '|' ||
               coalesce(new.actor_role, '') || '|' ||
               new.action || '|' ||
               coalesce(new.target_type, '') || '|' ||
               coalesce(new.target_id, '') || '|' ||
               coalesce(new.before_state::text, 'null') || '|' ||
               coalesce(new.after_state::text, 'null') || '|' ||
               coalesce(new.reason_code, '') || '|' ||
               coalesce(new.reason_text, '') || '|' ||
               coalesce(new.metadata::text, '{}');
  new.row_hash := encode(digest(v_payload, 'sha256'), 'hex');
  return new;
end;
$$;

drop trigger if exists admin_activity_log_hash_chain_t on public.admin_activity_log;
create trigger admin_activity_log_hash_chain_t
  before insert on public.admin_activity_log
  for each row execute function public.admin_activity_log_hash_chain();

create or replace function public.deny_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only; % denied', tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists admin_activity_log_no_update on public.admin_activity_log;
create trigger admin_activity_log_no_update
  before update on public.admin_activity_log
  for each row execute function public.deny_mutation();

drop trigger if exists admin_activity_log_no_delete on public.admin_activity_log;
create trigger admin_activity_log_no_delete
  before delete on public.admin_activity_log
  for each row execute function public.deny_mutation();

-- Hash-chain verifier: returns first id where the chain breaks, or null if intact.
create or replace function public.verify_admin_activity_chain(_limit int default null)
returns table (broken_at bigint)
language plpgsql stable as $$
declare
  r record;
  v_prev text;
  v_expected text;
  v_count int := 0;
begin
  v_prev := null;
  for r in
    select * from public.admin_activity_log order by id asc
  loop
    v_expected := encode(digest(
      coalesce(v_prev, '') || '|' ||
      r.occurred_at::text || '|' ||
      coalesce(r.request_id::text, '') || '|' ||
      coalesce(r.actor_id::text, '') || '|' ||
      coalesce(r.actor_role, '') || '|' ||
      r.action || '|' ||
      coalesce(r.target_type, '') || '|' ||
      coalesce(r.target_id, '') || '|' ||
      coalesce(r.before_state::text, 'null') || '|' ||
      coalesce(r.after_state::text, 'null') || '|' ||
      coalesce(r.reason_code, '') || '|' ||
      coalesce(r.reason_text, '') || '|' ||
      coalesce(r.metadata::text, '{}'),
      'sha256'
    ), 'hex');
    if v_expected <> r.row_hash then
      broken_at := r.id;
      return next;
      return;
    end if;
    v_prev := r.row_hash;
    v_count := v_count + 1;
    if _limit is not null and v_count >= _limit then
      exit;
    end if;
  end loop;
  return;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Reports, cases, and actions
-- ---------------------------------------------------------------------------

create table if not exists public.moderation_cases (
  id            uuid primary key default gen_random_uuid(),
  target_type   text not null,
  target_id     text not null,
  status        text not null default 'open'
                check (status in ('open','in_review','resolved','dismissed','appealed')),
  decision      text,
  decision_reason text,
  assignee_id   uuid,
  severity      int  not null default 1,        -- 1=low, 5=critical
  opened_at     timestamptz not null default now(),
  resolved_at   timestamptz,
  metadata      jsonb not null default '{}'::jsonb
);

create index if not exists moderation_cases_status_idx
  on public.moderation_cases (status, severity desc, opened_at);
create index if not exists moderation_cases_target_idx
  on public.moderation_cases (target_type, target_id);

create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid,
  target_type   text not null check (target_type in ('listing','user','comment','message','article')),
  target_id     text not null,
  reason_code   text not null,                   -- e.g. 'spam', 'scam', 'harassment'
  description   text,
  status        text not null default 'open'
                check (status in ('open','triaged','in_review','resolved','dismissed')),
  severity      int  not null default 1,
  assignee_id   uuid,
  case_id       uuid references public.moderation_cases(id) on delete set null,
  sla_due_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists reports_status_idx
  on public.reports (status, severity desc, created_at);
create index if not exists reports_target_idx
  on public.reports (target_type, target_id);
create index if not exists reports_assignee_idx
  on public.reports (assignee_id) where assignee_id is not null;

create table if not exists public.moderation_actions (
  id            bigserial primary key,
  occurred_at   timestamptz not null default now(),
  case_id       uuid references public.moderation_cases(id) on delete set null,
  actor_id      uuid,                              -- null when actor_kind='system'
  actor_kind    text not null default 'human' check (actor_kind in ('human','system')),
  actor_role    text,
  action        text not null,                    -- 'hide_listing','remove_listing','suspend_user','warn_user','dismiss_report','request_verification','verify_user','reject_verification','escalate'
  target_type   text not null,
  target_id     text not null,
  before_state  jsonb,
  after_state   jsonb,
  reason_code   text,
  reason_text   text,
  rule_id       text,                             -- when actor_kind='system'
  rule_version  text,
  metadata      jsonb not null default '{}'::jsonb
);

create index if not exists moderation_actions_case_idx
  on public.moderation_actions (case_id, occurred_at);
create index if not exists moderation_actions_target_idx
  on public.moderation_actions (target_type, target_id, occurred_at desc);
create index if not exists moderation_actions_actor_idx
  on public.moderation_actions (actor_id, occurred_at desc);

-- Insert-only enforcement
drop trigger if exists moderation_actions_no_update on public.moderation_actions;
create trigger moderation_actions_no_update
  before update on public.moderation_actions
  for each row execute function public.deny_mutation();

drop trigger if exists moderation_actions_no_delete on public.moderation_actions;
create trigger moderation_actions_no_delete
  before delete on public.moderation_actions
  for each row execute function public.deny_mutation();

-- ---------------------------------------------------------------------------
-- 4. Suspensions and verifications
-- ---------------------------------------------------------------------------

create table if not exists public.user_suspensions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  scope         text not null check (scope in ('full','listing','messaging')),
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz,                       -- null = permanent
  reason_code   text not null,
  reason_text   text,
  issued_by     uuid,
  appeal_status text not null default 'none'
                check (appeal_status in ('none','requested','upheld','overturned')),
  lifted_at     timestamptz,
  lifted_by     uuid,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists user_suspensions_user_idx
  on public.user_suspensions (user_id, starts_at desc);
create index if not exists user_suspensions_active_idx
  on public.user_suspensions (user_id)
  where lifted_at is null and (ends_at is null or ends_at > now());

create table if not exists public.verifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  type            text not null check (type in ('phone','email','id','business','address')),
  status          text not null default 'requested'
                  check (status in ('requested','submitted','in_review','approved','rejected','more_info_required','expired')),
  evidence_refs   jsonb not null default '[]'::jsonb,  -- list of storage object keys + sha256
  reviewer_id     uuid,
  second_reviewer_id uuid,                              -- separation of duties for high-tier
  decision_reason text,
  evidence_purge_at timestamptz,                        -- TTL after which evidence is purged
  requested_by    uuid,
  requested_at    timestamptz not null default now(),
  decided_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb
);

create index if not exists verifications_user_idx
  on public.verifications (user_id, requested_at desc);
create index if not exists verifications_status_idx
  on public.verifications (status, requested_at);

-- Block reviewers from approving their own submissions
create or replace function public.verifications_check_separation()
returns trigger language plpgsql as $$
begin
  if new.status in ('approved','rejected') then
    if new.reviewer_id is not null and new.reviewer_id = new.user_id then
      raise exception 'separation of duties: reviewer cannot decide their own verification'
        using errcode = '42501';
    end if;
    -- Business verifications require two distinct reviewers
    if new.type = 'business' and new.status = 'approved'
       and (new.second_reviewer_id is null or new.second_reviewer_id = new.reviewer_id) then
      raise exception 'business verification approval requires two distinct reviewers'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists verifications_check_separation_t on public.verifications;
create trigger verifications_check_separation_t
  before insert or update on public.verifications
  for each row execute function public.verifications_check_separation();

-- ---------------------------------------------------------------------------
-- 5. Fraud signals and risk scores
-- ---------------------------------------------------------------------------

create table if not exists public.fraud_rules (
  id            text primary key,
  description   text,
  rule_version  text not null default '1',
  enabled       boolean not null default true,
  mode          text not null default 'shadow' check (mode in ('shadow','enforce','disabled')),
  definition    jsonb not null,                   -- declarative DSL
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.fraud_signals (
  id            bigserial primary key,
  occurred_at   timestamptz not null default now(),
  subject_type  text not null check (subject_type in ('user','listing','device','ip','order')),
  subject_id    text not null,
  signal_code   text not null,
  score         numeric not null default 0,       -- 0..100
  source        text not null default 'rule' check (source in ('rule','model','manual')),
  rule_id       text,
  rule_version  text,
  evidence      jsonb not null default '{}'::jsonb,
  label         text                                  -- 'true_positive' | 'false_positive' | null
);

create index if not exists fraud_signals_subject_idx
  on public.fraud_signals (subject_type, subject_id, occurred_at desc);
create index if not exists fraud_signals_rule_idx
  on public.fraud_signals (rule_id, occurred_at desc);

create table if not exists public.risk_scores (
  subject_type  text not null,
  subject_id    text not null,
  score         numeric not null,
  band          text not null check (band in ('low','medium','high','critical')),
  inputs_hash   text not null,
  model_version text not null default 'v1',
  computed_at   timestamptz not null default now(),
  primary key (subject_type, subject_id)
);

-- ---------------------------------------------------------------------------
-- 6. Status flags on existing tables (best-effort; safe if table missing)
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.user_profiles') is not null then
    execute 'alter table public.user_profiles
             add column if not exists moderation_status text
               check (moderation_status in (''active'',''restricted'',''suspended'')) default ''active''';
    execute 'alter table public.user_profiles
             add column if not exists verified_id boolean default false';
    execute 'alter table public.user_profiles
             add column if not exists verified_business boolean default false';
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 7. Queue priority view + helpers
-- ---------------------------------------------------------------------------

create or replace view public.report_queue as
select
  r.id,
  r.target_type,
  r.target_id,
  r.reason_code,
  r.status,
  r.severity,
  r.assignee_id,
  r.case_id,
  r.created_at,
  r.sla_due_at,
  greatest(0, extract(epoch from (coalesce(r.sla_due_at, now() + interval '7 days') - now())) / 3600.0)
    as sla_hours_remaining,
  -- priority: higher = act sooner
  (
    r.severity * 100
    + case when r.sla_due_at is not null and r.sla_due_at < now() then 500 else 0 end
    + coalesce((
        select count(*) * 5
        from public.reports r2
        where r2.target_type = r.target_type
          and r2.target_id   = r.target_id
          and r2.status in ('open','triaged','in_review')
      ), 0)
    + coalesce((
        select rs.score::int
        from public.risk_scores rs
        where rs.subject_type = r.target_type
          and rs.subject_id   = r.target_id
      ), 0)
  ) as priority
from public.reports r
where r.status in ('open','triaged','in_review');

-- Permission check helper
create or replace function public.admin_has_permission(_user uuid, _permission text)
returns boolean language sql stable as $$
  select exists (
    select 1
    from public.admin_role_assignments a
    join public.role_permissions p on p.role_id = a.role_id
    where a.user_id = _user and p.permission = _permission
  );
$$;

-- ---------------------------------------------------------------------------
-- 8. Analytics rollup table
-- ---------------------------------------------------------------------------

create table if not exists public.moderation_metrics_daily (
  day                  date primary key,
  reports_opened       int not null default 0,
  reports_resolved     int not null default 0,
  reports_dismissed    int not null default 0,
  actions_total        int not null default 0,
  suspensions_issued   int not null default 0,
  verifications_approved int not null default 0,
  verifications_rejected int not null default 0,
  signals_emitted      int not null default 0,
  computed_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9. RLS
-- ---------------------------------------------------------------------------

alter table public.admin_activity_log    enable row level security;
alter table public.reports               enable row level security;
alter table public.moderation_cases      enable row level security;
alter table public.moderation_actions    enable row level security;
alter table public.user_suspensions      enable row level security;
alter table public.verifications         enable row level security;
alter table public.fraud_signals         enable row level security;
alter table public.risk_scores           enable row level security;
alter table public.fraud_rules           enable row level security;
alter table public.admin_roles           enable row level security;
alter table public.role_permissions      enable row level security;
alter table public.admin_role_assignments enable row level security;
alter table public.moderation_metrics_daily enable row level security;

-- Default-deny: only the moderation service (service_role) writes.
-- Admins with the right role can read via these policies.

-- Helper: current jwt user id
-- (uses Supabase's auth.uid())

-- Reports: read for users with reports.read
drop policy if exists reports_select_admin on public.reports;
create policy reports_select_admin on public.reports
  for select using (
    public.admin_has_permission(auth.uid(), 'reports.read')
    or auth.role() = 'service_role'
  );
-- Reporters can read their own reports
drop policy if exists reports_select_self on public.reports;
create policy reports_select_self on public.reports
  for select using (reporter_id = auth.uid());
-- Inserts by authenticated users (intake), service role unrestricted
drop policy if exists reports_insert_auth on public.reports;
create policy reports_insert_auth on public.reports
  for insert with check (
    auth.role() = 'service_role'
    or (auth.uid() is not null and reporter_id = auth.uid())
  );
-- Updates only by service role (moderation service)
drop policy if exists reports_update_service on public.reports;
create policy reports_update_service on public.reports
  for update using (auth.role() = 'service_role');

-- Cases
drop policy if exists cases_select on public.moderation_cases;
create policy cases_select on public.moderation_cases
  for select using (
    public.admin_has_permission(auth.uid(), 'cases.read')
    or auth.role() = 'service_role'
  );
drop policy if exists cases_write_service on public.moderation_cases;
create policy cases_write_service on public.moderation_cases
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Moderation actions: read for cases.read, insert via service role only
drop policy if exists actions_select on public.moderation_actions;
create policy actions_select on public.moderation_actions
  for select using (
    public.admin_has_permission(auth.uid(), 'cases.read')
    or auth.role() = 'service_role'
  );
drop policy if exists actions_insert_service on public.moderation_actions;
create policy actions_insert_service on public.moderation_actions
  for insert with check (auth.role() = 'service_role');

-- Admin activity log: read for audit.read, insert via service role only
drop policy if exists audit_select on public.admin_activity_log;
create policy audit_select on public.admin_activity_log
  for select using (
    public.admin_has_permission(auth.uid(), 'audit.read')
    or auth.role() = 'service_role'
  );
drop policy if exists audit_insert_service on public.admin_activity_log;
create policy audit_insert_service on public.admin_activity_log
  for insert with check (auth.role() = 'service_role');

-- Suspensions
drop policy if exists suspensions_select on public.user_suspensions;
create policy suspensions_select on public.user_suspensions
  for select using (
    user_id = auth.uid()
    or public.admin_has_permission(auth.uid(), 'cases.read')
    or auth.role() = 'service_role'
  );
drop policy if exists suspensions_write_service on public.user_suspensions;
create policy suspensions_write_service on public.user_suspensions
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Verifications: user sees their own; reviewers with permission see all
drop policy if exists verifications_select on public.verifications;
create policy verifications_select on public.verifications
  for select using (
    user_id = auth.uid()
    or public.admin_has_permission(auth.uid(), 'verifications.read')
    or auth.role() = 'service_role'
  );
drop policy if exists verifications_insert on public.verifications;
create policy verifications_insert on public.verifications
  for insert with check (
    (auth.uid() is not null and user_id = auth.uid())
    or auth.role() = 'service_role'
  );
drop policy if exists verifications_update_service on public.verifications;
create policy verifications_update_service on public.verifications
  for update using (auth.role() = 'service_role');

-- Fraud signals / scores / rules: admins read with proper perms; only service writes
drop policy if exists signals_select on public.fraud_signals;
create policy signals_select on public.fraud_signals
  for select using (
    public.admin_has_permission(auth.uid(), 'cases.read')
    or auth.role() = 'service_role'
  );
drop policy if exists signals_insert_service on public.fraud_signals;
create policy signals_insert_service on public.fraud_signals
  for insert with check (auth.role() = 'service_role');
drop policy if exists signals_update_service on public.fraud_signals;
create policy signals_update_service on public.fraud_signals
  for update using (auth.role() = 'service_role');

drop policy if exists scores_select on public.risk_scores;
create policy scores_select on public.risk_scores
  for select using (
    public.admin_has_permission(auth.uid(), 'cases.read')
    or auth.role() = 'service_role'
  );
drop policy if exists scores_write_service on public.risk_scores;
create policy scores_write_service on public.risk_scores
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists rules_select on public.fraud_rules;
create policy rules_select on public.fraud_rules
  for select using (
    public.admin_has_permission(auth.uid(), 'cases.read')
    or public.admin_has_permission(auth.uid(), 'fraud.rules.write')
    or auth.role() = 'service_role'
  );
drop policy if exists rules_write_service on public.fraud_rules;
create policy rules_write_service on public.fraud_rules
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- RBAC tables: admin-only writes via service role; admins with roles.manage can read
drop policy if exists roles_select on public.admin_roles;
create policy roles_select on public.admin_roles
  for select using (true);  -- catalog is non-sensitive
drop policy if exists roles_write on public.admin_roles;
create policy roles_write on public.admin_roles
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists role_perm_select on public.role_permissions;
create policy role_perm_select on public.role_permissions
  for select using (true);
drop policy if exists role_perm_write on public.role_permissions;
create policy role_perm_write on public.role_permissions
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists role_assign_select on public.admin_role_assignments;
create policy role_assign_select on public.admin_role_assignments
  for select using (
    user_id = auth.uid()
    or public.admin_has_permission(auth.uid(), 'roles.manage')
    or auth.role() = 'service_role'
  );
drop policy if exists role_assign_write on public.admin_role_assignments;
create policy role_assign_write on public.admin_role_assignments
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists metrics_select on public.moderation_metrics_daily;
create policy metrics_select on public.moderation_metrics_daily
  for select using (
    public.admin_has_permission(auth.uid(), 'analytics.read')
    or auth.role() = 'service_role'
  );
drop policy if exists metrics_write_service on public.moderation_metrics_daily;
create policy metrics_write_service on public.moderation_metrics_daily
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- 10. Updated_at trigger for reports
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end$$;

drop trigger if exists reports_touch_updated_at on public.reports;
create trigger reports_touch_updated_at
  before update on public.reports
  for each row execute function public.touch_updated_at();
