-- ===== WinMix cloud tier — read-only, additive =====

create table if not exists public.winmix_teams (
  id            uuid primary key default gen_random_uuid(),
  league        text not null check (league in ('angol','spanyol')),
  canonical_key text not null,
  display_name  text not null,
  weight_index  numeric(4,1) not null default 5.0 check (weight_index between 0 and 10),
  weight_source text not null default 'auto' check (weight_source in ('auto','manual')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (league, canonical_key)
);

create table if not exists public.winmix_seasons (
  id           uuid primary key default gen_random_uuid(),
  league       text not null check (league in ('angol','spanyol')),
  season_index int  not null,
  name         text not null,
  file_name    text not null,
  content_hash text,
  match_count  int  not null default 0,
  order_mode   text not null default 'chronological'
               check (order_mode in ('chronological','source-order')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (league, season_index)
);

create table if not exists public.winmix_matches (
  id             uuid primary key default gen_random_uuid(),
  season_id      uuid not null references public.winmix_seasons(id) on delete cascade,
  league         text not null check (league in ('angol','spanyol')),
  match_no       int  not null,
  source_file_id text,
  row_index      int,
  kickoff_iso    timestamptz,
  match_date_raw text,
  home_team_id   uuid not null references public.winmix_teams(id),
  away_team_id   uuid not null references public.winmix_teams(id),
  ht_home_score  int check (ht_home_score >= 0),
  ht_away_score  int check (ht_away_score >= 0),
  home_score     int not null check (home_score >= 0),
  away_score     int not null check (away_score >= 0),
  total_goals    int generated always as (home_score + away_score) stored,
  btts           boolean generated always as (home_score > 0 and away_score > 0) stored,
  outcome        text generated always as (
                   case when home_score > away_score then 'H'
                        when home_score < away_score then 'A'
                        else 'D' end) stored,
  created_at     timestamptz not null default now(),
  constraint winmix_ht_le_ft check (
    (ht_home_score is null or ht_home_score <= home_score) and
    (ht_away_score is null or ht_away_score <= away_score)
  ),
  unique (season_id, match_no)
);

create index if not exists winmix_matches_league_idx    on public.winmix_matches (league);
create index if not exists winmix_matches_home_team_idx on public.winmix_matches (home_team_id);
create index if not exists winmix_matches_away_team_idx on public.winmix_matches (away_team_id);
create index if not exists winmix_matches_kickoff_idx   on public.winmix_matches (kickoff_iso);

create table if not exists public.winmix_pipeline_checkpoints (
  league                 text primary key check (league in ('angol','spanyol')),
  feature_schema_version int  not null,
  processed_match_count  int  not null,
  prefix_signature       text not null,
  weights_signature      text not null,
  experiments_key        text not null,
  history_scope          text not null check (history_scope in ('season-only','league-cumulative')),
  calibration_t          numeric,
  ensemble_w_m1          numeric,
  ensemble_tuned         boolean,
  m1_fit                 jsonb,
  calib_history          jsonb,
  fit_history            jsonb,
  saved_at               timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- updated_at triggers (touch_updated_at already exists in this project)
create trigger trg_touch_winmix_teams_updated_at
  before update on public.winmix_teams
  for each row execute function public.touch_updated_at();
create trigger trg_touch_winmix_seasons_updated_at
  before update on public.winmix_seasons
  for each row execute function public.touch_updated_at();
create trigger trg_touch_winmix_checkpoints_updated_at
  before update on public.winmix_pipeline_checkpoints
  for each row execute function public.touch_updated_at();

-- ===== GRANTs: read-only for anon/authenticated, full for service_role =====
grant usage on schema public to anon, authenticated;

grant select on public.winmix_teams                to anon, authenticated;
grant select on public.winmix_seasons              to anon, authenticated;
grant select on public.winmix_matches              to anon, authenticated;
grant select on public.winmix_pipeline_checkpoints to anon, authenticated;

grant all on public.winmix_teams                to service_role;
grant all on public.winmix_seasons              to service_role;
grant all on public.winmix_matches              to service_role;
grant all on public.winmix_pipeline_checkpoints to service_role;

-- ===== RLS: select-only policies, no write policies at all =====
alter table public.winmix_teams                enable row level security;
alter table public.winmix_seasons              enable row level security;
alter table public.winmix_matches              enable row level security;
alter table public.winmix_pipeline_checkpoints enable row level security;

create policy winmix_teams_read_all       on public.winmix_teams
  for select to anon, authenticated using (true);
create policy winmix_seasons_read_all     on public.winmix_seasons
  for select to anon, authenticated using (true);
create policy winmix_matches_read_all     on public.winmix_matches
  for select to anon, authenticated using (true);
create policy winmix_checkpoints_read_all on public.winmix_pipeline_checkpoints
  for select to anon, authenticated using (true);

-- ===== view_team_ratings — SQL mirror of computeAutoTeamWeights() =====
create or replace view public.view_team_ratings
with (security_invoker = true) as
with per_team as (
  select
    t.league,
    t.canonical_key,
    t.display_name,
    count(*) filter (where m.home_team_id = t.id) as home_games,
    count(*) filter (where m.away_team_id = t.id) as away_games,
    coalesce(sum(m.home_score) filter (where m.home_team_id = t.id), 0) as home_gf,
    coalesce(sum(m.away_score) filter (where m.home_team_id = t.id), 0) as home_ga,
    coalesce(sum(m.away_score) filter (where m.away_team_id = t.id), 0) as away_gf,
    coalesce(sum(m.home_score) filter (where m.away_team_id = t.id), 0) as away_ga,
    coalesce(sum(
      case
        when m.home_team_id = t.id and m.outcome = 'H' then 3
        when m.away_team_id = t.id and m.outcome = 'A' then 3
        when m.outcome = 'D' then 1
        else 0
      end), 0) as pts
  from public.winmix_teams t
  left join public.winmix_matches m
    on (m.home_team_id = t.id or m.away_team_id = t.id)
   and m.league = t.league
  group by t.league, t.canonical_key, t.display_name, t.id
),
scored as (
  select
    league, canonical_key, display_name,
    (home_games + away_games) as total_played,
    case when home_games > 0 then (home_gf - home_ga)::numeric / home_games else 0 end as net_home,
    case when away_games > 0 then (away_gf - away_ga)::numeric / away_games else 0 end as net_away,
    case when (home_games + away_games) > 0
         then pts::numeric / (home_games + away_games)
         else 1.35 end as ppg
  from per_team
),
raw as (
  select *,
    0.55 * net_home + 0.45 * net_away + 0.33 * ppg as raw_score
  from scored
),
standardized as (
  select *,
    avg(raw_score) over (partition by league) as mu,
    coalesce(nullif(stddev_pop(raw_score) over (partition by league), 0), 1) as sigma
  from raw
)
select
  league,
  canonical_key,
  display_name,
  total_played,
  round(net_home, 2) as net_home,
  round(net_away, 2) as net_away,
  round(ppg, 2)      as ppg,
  greatest(0, least(10,
    round((5.0 + ((raw_score - mu) / sigma) * 1.75)::numeric, 1)
  )) as auto_weight_index
from standardized;

grant select on public.view_team_ratings to anon, authenticated, service_role;

notify pgrst, 'reload schema';