// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface MatchInput {
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
}

interface SeasonInput {
  id: string;
  league: "angol" | "spanyol";
  seasonIndex: number;
  name: string;
  fileName: string;
  createdAt: string;
  contentHash: string | null;
  orderMode: string;
  matches: MatchInput[];
}

interface IngestPayload {
  seasons: SeasonInput[];
  teamWeights?: Record<string, Record<string, number>>;
  teamAliasMap?: Record<string, Record<string, string>>;
}

const MAX_GOALS = 20;

function canon(name: string | null | undefined): string {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function checkScores(
  homeScore: number,
  awayScore: number,
  htHome: number | null,
  htAway: number | null,
): { ok: boolean; htHome: number | null; htAway: number | null; reason?: string } {
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
    return { ok: false, htHome: null, htAway: null, reason: "Érvénytelen végeredmény" };
  }
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) {
    return { ok: false, htHome: null, htAway: null, reason: "Nem egész szám végeredmény" };
  }
  if (homeScore < 0 || awayScore < 0) {
    return { ok: false, htHome: null, htAway: null, reason: "Negatív végeredmény" };
  }
  if (homeScore > MAX_GOALS || awayScore > MAX_GOALS) {
    return { ok: false, htHome: null, htAway: null, reason: "Valószerűtlen végeredmény" };
  }

  const hasH = htHome !== null && htHome !== undefined;
  const hasA = htAway !== null && htAway !== undefined;
  if (!hasH && !hasA) return { ok: true, htHome: null, htAway: null };
  if (hasH !== hasA) return { ok: true, htHome: null, htAway: null };
  const h = htHome as number;
  const a = htAway as number;
  if (!Number.isFinite(h) || !Number.isFinite(a)) return { ok: true, htHome: null, htAway: null };
  if (h < 0 || a < 0 || h > MAX_GOALS || a > MAX_GOALS) return { ok: true, htHome: null, htAway: null };
  if (h > homeScore || a > awayScore) return { ok: true, htHome: null, htAway: null };
  return { ok: true, htHome: h, htAway: a };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Csak POST támogatott" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: "Hiányzó SUPABASE_URL vagy SUPABASE_SERVICE_ROLE_KEY" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let payload: IngestPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Érvénytelen JSON payload" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!payload.seasons || !Array.isArray(payload.seasons) || payload.seasons.length === 0) {
    return new Response(JSON.stringify({ error: "Nincsenek szezonok a payload-ban" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const stats = {
    seasons: 0,
    teams: 0,
    matches: 0,
    rejected: 0,
    repaired: 0,
    errors: [] as string[],
  };

  for (const season of payload.seasons) {
    const league = season.league;
    if (league !== "angol" && league !== "spanyol") {
      stats.errors.push(`Szezon "${season.name}": ismeretlen liga "${league}"`);
      continue;
    }

    // 1. Season upsert (idempotens — unique: league + season_index)
    const { data: seasonRow, error: seasonErr } = await admin
      .from("winmix_seasons")
      .upsert(
        {
          league,
          season_index: season.seasonIndex,
          name: season.name,
          file_name: season.fileName,
          content_hash: season.contentHash ?? null,
          match_count: season.matches.length,
          order_mode: season.orderMode === "source-order" ? "source-order" : "chronological",
        },
        { onConflict: "league,season_index" },
      )
      .select("id")
      .single();

    if (seasonErr || !seasonRow) {
      stats.errors.push(`Szezon "${season.name}": ${seasonErr?.message ?? "ismeretlen hiba"}`);
      continue;
    }
    const seasonId = seasonRow.id;
    stats.seasons++;

    // 2. Collect unique teams and upsert
    const teamMap = new Map<string, string>(); // canonical_key -> display_name
    for (const m of season.matches) {
      const hKey = canon(m.home_team);
      const aKey = canon(m.away_team);
      if (hKey && !teamMap.has(hKey)) teamMap.set(hKey, m.home_team);
      if (aKey && !teamMap.has(aKey)) teamMap.set(aKey, m.away_team);
    }

    // Apply alias map if provided
    const aliases = payload.teamAliasMap?.[league] ?? {};
    for (const [key, display] of Object.entries(aliases)) {
      if (teamMap.has(key) && !teamMap.get(key)) {
        teamMap.set(key, display);
      }
    }

    // Compute weight index from provided weights or default 5.0
    const weights = payload.teamWeights?.[league] ?? {};

    const teamRows = Array.from(teamMap.entries()).map(([canonicalKey, displayName]) => ({
      league,
      canonical_key: canonicalKey,
      display_name: displayName,
      weight_index: typeof weights[canonicalKey] === "number" ? weights[canonicalKey] : 5.0,
      weight_source: "auto",
    }));

    if (teamRows.length > 0) {
      const { error: teamErr } = await admin
        .from("winmix_teams")
        .upsert(teamRows, { onConflict: "league,canonical_key" });

      if (teamErr) {
        stats.errors.push(`Szezon "${season.name}" csapatok: ${teamErr.message}`);
        continue;
      }
      stats.teams += teamRows.length;
    }

    // 3. Fetch team IDs for FK resolution
    const { data: teamIdRows, error: teamIdErr } = await admin
      .from("winmix_teams")
      .select("id, canonical_key")
      .eq("league", league);

    if (teamIdErr || !teamIdRows) {
      stats.errors.push(`Szezon "${season.name}" team ID fetch: ${teamIdErr?.message ?? "ismeretlen"}`);
      continue;
    }

    const teamIdMap = new Map<string, string>();
    for (const r of teamIdRows) {
      teamIdMap.set(r.canonical_key, r.id);
    }

    // 4. Match upsert (idempotens — unique: season_id + match_no)
    const matchRows: Record<string, unknown>[] = [];
    let matchNo = 0;
    for (const m of season.matches) {
      matchNo++;
      const hKey = canon(m.home_team);
      const aKey = canon(m.away_team);
      const homeId = teamIdMap.get(hKey);
      const awayId = teamIdMap.get(aKey);

      if (!homeId || !awayId) {
        stats.rejected++;
        continue;
      }

      const check = checkScores(m.home_score, m.away_score, m.ht_home_score, m.ht_away_score);
      if (!check.ok) {
        stats.rejected++;
        continue;
      }
      if (check.htHome === null && (m.ht_home_score !== null && m.ht_home_score !== undefined)) {
        stats.repaired++;
      }

      matchRows.push({
        season_id: seasonId,
        league,
        match_no: matchNo,
        source_file_id: m.sourceFileId ?? null,
        row_index: m.rowIndex ?? null,
        kickoff_iso: m.kickoffIso ?? null,
        match_date_raw: m.date ?? null,
        home_team_id: homeId,
        away_team_id: awayId,
        ht_home_score: check.htHome,
        ht_away_score: check.htAway,
        home_score: m.home_score,
        away_score: m.away_score,
      });
    }

    if (matchRows.length > 0) {
      const { error: matchErr } = await admin
        .from("winmix_matches")
        .upsert(matchRows, { onConflict: "season_id,match_no" });

      if (matchErr) {
        stats.errors.push(`Szezon "${season.name}" mérkőzések: ${matchErr.message}`);
        continue;
      }
      stats.matches += matchRows.length;
    }
  }

  return new Response(
    JSON.stringify({
      success: stats.errors.length === 0,
      ...stats,
    }),
    {
      status: stats.errors.length === 0 ? 200 : 207,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
