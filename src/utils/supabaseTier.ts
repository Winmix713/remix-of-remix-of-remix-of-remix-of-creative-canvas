/**
 * PHASE 5 — Supabase as an ADDITIONAL, read-only, opt-in tier.
 *
 * Hard rules encoded here:
 *  • Only the ANON key is ever read from the environment. A service-role key is
 *    a server-only secret (ingestion CLI / edge function) and must never be
 *    referenced from client code — see docs/supabase-migration.md.
 *  • RLS grants `select` and nothing else to anon, so this module never
 *    attempts a write. Persistence of app state stays on the existing
 *    localStorage tier, with its corruption quarantine and JSON export intact.
 *  • Any failure — unconfigured, offline, timeout, RLS rejection — degrades the
 *    session to 'local' for good and surfaces a banner. Supabase is never a
 *    hard dependency.
 *  • Anything fetched from SQL is ADVISORY / UI-only. It never feeds the
 *    pipeline, the joint score matrix, or the seeded bootstrap.
 */
import type { League } from '../types/winmix';
import { readCloudEnv } from './cloudConfig';

const PROBE_TIMEOUT_MS = 4000;

const readEnv = readCloudEnv;

/** Turns a PostgREST status code into something a human can act on. */
function describeHttpError(status: number, statusText: string): string {
  switch (status) {
    case 401:
      return 'HTTP 401 — az anon kulcsot a projekt elutasította. Ellenőrizd, hogy a kulcs ehhez a projekthez tartozik-e, és hogy a legacy JWT kulcsok engedélyezve vannak-e (új projekteknél a publishable kulcs kell).';
    case 403:
      return 'HTTP 403 — a kulcs érvényes, de az RLS nem enged `select`-et az anon szerepnek.';
    case 404:
      return 'HTTP 404 — a kért nézet/tábla nem létezik ebben a projektben (lásd docs/supabase-migration.md).';
    case 429:
      return 'HTTP 429 — túl sok kérés, próbáld újra később.';
    default:
      return `HTTP ${status} — ${statusText || 'kérés elutasítva'}`;
  }
}

/** Non-secret connection summary for the diagnostics panel. */
export function cloudEndpointSummary(): {url: string;source: 'override' | 'env' | 'fallback';} | null {
  const env = readEnv();
  return env ? { url: env.url, source: env.source } : null;
}

export function isCloudTierConfigured(): boolean {
  return readEnv() !== null;
}

export type CloudTierStatus = 'unconfigured' | 'probing' | 'online' | 'degraded';

export interface CloudTierHealth {
  status: CloudTierStatus;
  /** Sticky for the whole session once a call has failed. */
  degraded: boolean;
  lastError: string | null;
  checkedAt: string | null;
}

export function idleHealth(): CloudTierHealth {
  return {
    status: isCloudTierConfigured() ? 'probing' : 'unconfigured',
    degraded: false,
    lastError: null,
    checkedAt: null
  };
}

/** Carries the HTTP status so callers can branch (404 → fall back, 401 → stop). */
export class CloudHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CloudHttpError';
    this.status = status;
  }
}

/** PostgREST returns `{ message, hint, details, code }` on every error. */
async function readPostgrestDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const parts = [body.message, body.hint, body.details].
    filter((v): v is string => typeof v === 'string' && v.length > 0).
    map((v) => v.trim());
    const code = typeof body.code === 'string' ? ` (${body.code})` : '';
    return parts.length ? ` · PostgREST: ${parts.join(' — ')}${code}` : '';
  } catch {
    return '';
  }
}

/** New `sb_publishable_…` keys are opaque strings, not JWTs — never send them as Bearer. */
function isOpaqueKey(key: string): boolean {
  return key.startsWith('sb_publishable_') || key.startsWith('sb_secret_');
}

async function restGet(path: string): Promise<unknown> {
  const env = readEnv();
  if (!env) throw new Error('A felhő tier nincs konfigurálva (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      // The key belongs in `apikey`. Legacy JWT anon keys are mirrored into
      // `Authorization` so PostgREST resolves the role; opaque publishable keys
      // must NOT be sent as Bearer (PostgREST answers 401 "Expected 3 parts").
      apikey: env.anonKey,
      Accept: 'application/json'
    };
    if (!isOpaqueKey(env.anonKey)) headers.Authorization = `Bearer ${env.anonKey}`;
    const res = await fetch(`${env.url}/rest/v1/${path}`, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await readPostgrestDetail(res);
      throw new CloudHttpError(res.status, describeHttpError(res.status, res.statusText) + detail);
    }
    return (await res.json()) as unknown;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Reachability + RLS probe. Never throws; the caller degrades on `false`. */
export async function probeCloudTier(): Promise<CloudTierHealth> {
  if (!isCloudTierConfigured()) {
    return {
      status: 'unconfigured',
      degraded: false,
      lastError: null,
      checkedAt: new Date().toISOString()
    };
  }
  try {
    // Probe the view the cross-check actually reads. A 404 only means the view
    // is not deployed yet, so fall back to the REST root to prove reachability.
    // A 401/403 is a real credential/RLS/GRANT problem and must not be masked.
    try {
      await restGet('view_team_ratings?select=canonical_key&limit=1');
    } catch (e) {
      if (e instanceof CloudHttpError && (e.status === 401 || e.status === 403)) throw e;
      await restGet('');
    }
    return { status: 'online', degraded: false, lastError: null, checkedAt: new Date().toISOString() };
  } catch (e) {
    return {
      status: 'degraded',
      degraded: true,
      lastError: e instanceof Error ? e.message : String(e),
      checkedAt: new Date().toISOString()
    };
  }
}

/** One row of `view_team_ratings` — advisory, cross-check material only. */
export interface CloudTeamRating {
  canonicalKey: string;
  displayName: string;
  totalPlayed: number;
  netHome: number;
  netAway: number;
  ppg: number;
  autoWeightIndex: number;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reads the SQL-side ratings view for cross-checking against
 * `computeAutoTeamWeights()`. UI-only: these numbers are displayed and diffed,
 * never applied as weights and never fed into the pipeline.
 */
export async function fetchCloudTeamRatings(league: League): Promise<CloudTeamRating[]> {
  const raw = await restGet(
    `view_team_ratings?league=eq.${encodeURIComponent(league)}&select=canonical_key,display_name,total_played,net_home,net_away,ppg,auto_weight_index`
  );
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      canonicalKey: String(r.canonical_key ?? ''),
      displayName: String(r.display_name ?? ''),
      totalPlayed: num(r.total_played),
      netHome: num(r.net_home),
      netAway: num(r.net_away),
      ppg: num(r.ppg),
      autoWeightIndex: num(r.auto_weight_index)
    };
  });
}

export interface IngestResult {
  success: boolean;
  seasons: number;
  teams: number;
  matches: number;
  rejected: number;
  repaired: number;
  errors: string[];
}

/**
 * Uploads local seasons to the Supabase cloud tier via the winmix-ingest edge
 * function. The function reads the service-role key from its own Deno env at
 * runtime, so the browser only needs the publishable/anon key for the gateway.
 * Opaque `sb_publishable_` keys go in `apikey` only — never as `Bearer`.
 *
 * Idempotent: re-uploading the same seasons safely upserts (no duplicates).
 */
export async function ingestSeasonsToCloud(params: {
  seasons: Array<{
    id: string;
    league: League;
    seasonIndex: number;
    name: string;
    fileName: string;
    createdAt: string;
    contentHash: string | null;
    orderMode?: string;
    matches: Array<{
      match_no: number;
      date: string;
      kickoffIso?: string | null;
      rowIndex?: number;
      sourceFileId?: string | null;
      home_team: string;
      away_team: string;
      ht_home_score: number | null;
      ht_away_score: number | null;
      home_score: number;
      away_score: number;
    }>;
  }>;
  teamWeights?: Record<string, Record<string, number>>;
  teamAliasMap?: Record<string, Record<string, string>>;
}): Promise<IngestResult> {
  const env = readEnv();
  if (!env) {
    return {
      success: false,
      seasons: 0,
      teams: 0,
      matches: 0,
      rejected: 0,
      repaired: 0,
      errors: ['A felhő tier nincs konfigurálva.'],
    };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30000);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      apikey: env.anonKey,
    };
    if (!isOpaqueKey(env.anonKey)) {
      headers.Authorization = `Bearer ${env.anonKey}`;
    }
    const res = await fetch(`${env.url}/functions/v1/winmix-ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        seasons: params.seasons,
        teamWeights: params.teamWeights,
        teamAliasMap: params.teamAliasMap,
      }),
      signal: controller.signal,
    });

    const body = await res.json().catch(() => ({ error: 'Érvénytelen válasz a szervertől' }));

    if (!res.ok) {
      return {
        success: false,
        seasons: 0,
        teams: 0,
        matches: 0,
        rejected: 0,
        repaired: 0,
        errors: [body.error ?? `HTTP ${res.status}`],
      };
    }

    return {
      success: body.success ?? false,
      seasons: body.seasons ?? 0,
      teams: body.teams ?? 0,
      matches: body.matches ?? 0,
      rejected: body.rejected ?? 0,
      repaired: body.repaired ?? 0,
      errors: body.errors ?? [],
    };
  } catch (e) {
    return {
      success: false,
      seasons: 0,
      teams: 0,
      matches: 0,
      rejected: 0,
      repaired: 0,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export interface DownloadResult {
  seasons: number;
  matches: number;
  failures: string[];
}

/**
 * Downloads seasons + matches from the Supabase cloud tier (winmix_seasons +
 * winmix_matches) via the anon-key REST API and converts them into the Season[]
 * shape the WinMix engine expects. Read-only, RLS-gated.
 */
export async function downloadSeasonsFromCloud(league: League): Promise<DownloadResult> {
  const env = readEnv();
  if (!env) {
    return { seasons: 0, matches: 0, failures: ['A felhő tier nincs konfigurálva.'] };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30000);

  try {
    const headers: Record<string, string> = {
      apikey: env.anonKey,
      Accept: 'application/json',
    };
    if (!isOpaqueKey(env.anonKey)) {
      headers.Authorization = `Bearer ${env.anonKey}`;
    }

    const seasonRes = await fetch(
      `${env.url}/rest/v1/winmix_seasons?league=eq.${encodeURIComponent(league)}&select=id,league,season_index,name,file_name,created_at,content_hash,order_mode,match_count`,
      { method: 'GET', headers, signal: controller.signal },
    );

    if (!seasonRes.ok) {
      const detail = await readPostgrestDetail(seasonRes);
      return {
        seasons: 0,
        matches: 0,
        failures: [`winmix_seasons: ${describeHttpError(seasonRes.status, seasonRes.statusText)}${detail}`],
      };
    }

    const seasonRows = await seasonRes.json();
    if (!Array.isArray(seasonRows) || seasonRows.length === 0) {
      return { seasons: 0, matches: 0, failures: [] };
    }

    const seasonIds = seasonRows.map((r: Record<string, unknown>) => r.id);
    const matchRes = await fetch(
      `${env.url}/rest/v1/winmix_matches?season_id=in.(${seasonIds.map(encodeURIComponent).join(',')})&select=season_id,match_no,date,match_date_raw,kickoff_iso,row_index,source_file_id,home_team_id,away_team_id,ht_home_score,ht_away_score,home_score,away_score,total_goals,btts,outcome,league`,
      { method: 'GET', headers, signal: controller.signal },
    );

    if (!matchRes.ok) {
      const detail = await readPostgrestDetail(matchRes);
      return {
        seasons: 0,
        matches: 0,
        failures: [`winmix_matches: ${describeHttpError(matchRes.status, matchRes.statusText)}${detail}`],
      };
    }

    const matchRows = await matchRes.json();
    if (!Array.isArray(matchRows)) {
      return { seasons: 0, matches: 0, failures: ['Érvénytelen válasz a szerverről.'] };
    }

    // Group matches by season_id
    const matchesBySeason = new Map<string, unknown[]>();
    for (const m of matchRows) {
      const sid = (m as Record<string, unknown>).season_id;
      if (typeof sid !== 'string') continue;
      const bucket = matchesBySeason.get(sid);
      if (bucket) {
        bucket.push(m);
      } else {
        matchesBySeason.set(sid, [m]);
      }
    }

    // Build Season[] in the engine's format
    const seasons: Array<{
      id: string;
      league: League;
      seasonIndex: number;
      name: string;
      fileName: string;
      createdAt: string;
      contentHash: string | null;
      orderMode: string;
      matches: Array<{
        match_no: number;
        date: string;
        kickoffIso: string | null;
        rowIndex: number | null;
        sourceFileId: string | null;
        home_team: string;
        away_team: string;
        ht_home_score: number | null;
        ht_away_score: number | null;
        home_score: number;
        away_score: number;
      }>;
    }> = [];

    let totalMatches = 0;

    for (const sr of seasonRows as Record<string, unknown>[]) {
      const sid = String(sr.id ?? '');
      const rawMatches = matchesBySeason.get(sid) ?? [];

      const matches = rawMatches.map((m: Record<string, unknown>) => ({
        match_no: num(m.match_no),
        date: String(m.match_date_raw ?? m.date ?? ''),
        kickoffIso: typeof m.kickoff_iso === 'string' ? m.kickoff_iso : null,
        rowIndex: typeof m.row_index === 'number' ? m.row_index : null,
        sourceFileId: typeof m.source_file_id === 'string' ? m.source_file_id : null,
        home_team: String(m.home_team_id ?? ''),
        away_team: String(m.away_team_id ?? ''),
        ht_home_score: typeof m.ht_home_score === 'number' ? m.ht_home_score : null,
        ht_away_score: typeof m.ht_away_score === 'number' ? m.ht_away_score : null,
        home_score: num(m.home_score),
        away_score: num(m.away_score),
      }));

      totalMatches += matches.length;

      seasons.push({
        id: sid,
        league: String(sr.league) as League,
        seasonIndex: num(sr.season_index),
        name: String(sr.name ?? ''),
        fileName: String(sr.file_name ?? ''),
        createdAt: String(sr.created_at ?? new Date().toISOString()),
        contentHash: typeof sr.content_hash === 'string' ? sr.content_hash : null,
        orderMode: String(sr.order_mode ?? 'chronological'),
        matches,
      });
    }

    // Store in sessionStorage for the ops hook to pick up
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      settings: null,
      calibration: {},
      teamWeights: {},
      teamAliasMap: {},
      seasonCounters: {},
      seasons,
    };
    sessionStorage.setItem('winmix_cloud_download', JSON.stringify(payload));

    return { seasons: seasons.length, matches: totalMatches, failures: [] };
  } catch (e) {
    return {
      seasons: 0,
      matches: 0,
      failures: [e instanceof Error ? e.message : String(e)],
    };
  } finally {
    window.clearTimeout(timer);
  }
}