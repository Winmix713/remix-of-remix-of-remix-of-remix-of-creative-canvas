import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Trophy,
  TrendingUp,
  Swords,
  ListOrdered,
  Grid3x3,
} from 'lucide-react';

import { useWinmix } from '../contexts/WinmixContext';
import { LEAGUE_LABEL, LEAGUE_FLAG } from '../data/leagues';
import { PageHeader } from '../components/winmix/PageHeader';
import {
  Panel,
  PanelHeader,
  PanelTitle,
  PanelSubtitle,
  SectionHeading,
} from '../components/winmix/Panel';
import { MetricCard, MetricGrid } from '../components/winmix/MetricCard';
import {
  Table,
  TableScroll,
  Td,
  TdLabel,
  TeamBadge,
  Th,
  Tr,
} from '../components/winmix/DataTable';

import {
  buildLeagueAnalyzerData,
  computePositionHistory,
  computeResultMatrix,
  computeTeamMatches,
  computeCurrentAndNextFixtures,
  type TeamOverUnderRow,
  type TeamFormRow,
  type ResultMatrixCell,
  type FixtureEntry,
  type TeamMatchEntry,
} from '../utils/leagueStats';

import { summarizeMatchup, type MatchupSummary } from '../utils/h2h';
import { cn } from '../lib/utils';

const INTRO =
  'Bajnokságonkénti teljesítmény és csapat-szintű statisztikák egyetlen folyamatos nézetben — a tabellától az Over/Under és forma táblán át a két csapat összehasonlításáig és az eredmény-mátrixig.';

const FORM_COLORS: Record<string, string> = {
  W: 'bg-positive text-positive-foreground',
  D: 'bg-white/[0.08] text-muted-foreground',
  L: 'bg-negative text-negative-foreground',
};

function formLabel(r: string): string {
  if (r === 'W') return 'G';
  if (r === 'D') return 'D';
  return 'V';
}

function outcomeColor(outcome: 'W' | 'D' | 'L'): string {
  if (outcome === 'W') return 'text-positive';
  if (outcome === 'D') return 'text-muted-foreground';
  return 'text-negative';
}

function cellBg(outcome: 'W' | 'D' | 'L'): string {
  if (outcome === 'W') return 'bg-positive-soft';
  if (outcome === 'D') return 'bg-white/[0.06]';
  return 'bg-negative-soft';
}

/* -------------------------------------------------------------------------- *
 * Shared types                                                               *
 * -------------------------------------------------------------------------- */

type TeamPoolRow = {
  key: string;
  display: string;
  played: number;
};

type StandingRows = ReturnType<typeof buildLeagueAnalyzerData>['standings'];

type PositionHistoryTeam = {
  key: string;
  displayName: string;
  history: {
    round: number;
    position: number;
  }[];
};

type PositionHistoryPair = {
  a: PositionHistoryTeam | null;
  b: PositionHistoryTeam | null;
};

/* -------------------------------------------------------------------------- *
 * Page                                                                       *
 * -------------------------------------------------------------------------- */

export function LeagueAnalyzer() {
  const {
    seasons,
    currentLeague,
    teamWeights,
    teamAliasMap,
    selectedSeason,
  } = useWinmix();

  /* ---------------------------------------------------------------------- *
   * Stable league scope
   *
   * This is intentionally calculated once and then reused by every
   * team-level analysis below.
   * ---------------------------------------------------------------------- */

  const leagueSeasons = useMemo(
    () => seasons.filter((season) => season.league === currentLeague),
    [seasons, currentLeague],
  );

  const leagueMatches = useMemo(
    () => leagueSeasons.flatMap((season) => season.matches),
    [leagueSeasons],
  );

  const aliases = useMemo(
    () => teamAliasMap[currentLeague] ?? {},
    [teamAliasMap, currentLeague],
  );

  const leagueWeights = useMemo(
    () => teamWeights[currentLeague] ?? {},
    [teamWeights, currentLeague],
  );

  /*
   * A selected season from another league must never leak into this page.
   */
  const scopedSelectedSeason = useMemo(
    () =>
      selectedSeason?.league === currentLeague
        ? selectedSeason
        : null,
    [selectedSeason, currentLeague],
  );

  /* ---------------------------------------------------------------------- *
   * Main aggregated data
   * ---------------------------------------------------------------------- */

  const data = useMemo(
    () =>
      buildLeagueAnalyzerData(
        seasons,
        currentLeague,
        teamWeights,
        teamAliasMap,
        scopedSelectedSeason,
      ),
    [
      seasons,
      currentLeague,
      teamWeights,
      teamAliasMap,
      scopedSelectedSeason,
    ],
  );

  /* ---------------------------------------------------------------------- *
   * Current / next fixtures
   * ---------------------------------------------------------------------- */

  const fixtures = useMemo(
    () =>
      scopedSelectedSeason
        ? computeCurrentAndNextFixtures(
            scopedSelectedSeason,
            aliases,
          )
        : {
            current: [] as FixtureEntry[],
            next: [] as FixtureEntry[],
          },
    [scopedSelectedSeason, aliases],
  );

  /* ---------------------------------------------------------------------- *
   * Team selection state
   * ---------------------------------------------------------------------- */

  const [teamAKey, setTeamAKey] = useState<string | null>(null);
  const [teamBKey, setTeamBKey] = useState<string | null>(null);
  const [matrixTeamKey, setMatrixTeamKey] = useState<string | null>(null);

  const teamPool = data.teamPool;

  /*
   * The pool can change after:
   *   - league change
   *   - season change
   *   - import
   *   - dataset replacement
   *
   * Never leave stale team IDs in the selection state.
   */
  const teamKeys = useMemo(
    () => new Set(teamPool.map((team) => team.key)),
    [teamPool],
  );

  useEffect(() => {
    setTeamAKey((current) =>
      current && teamKeys.has(current) ? current : null,
    );

    setTeamBKey((current) =>
      current && teamKeys.has(current) ? current : null,
    );

    setMatrixTeamKey((current) =>
      current && teamKeys.has(current) ? current : null,
    );
  }, [teamKeys]);

  /*
   * Do not allow A and B to remain the same after a pool/state change.
   */
  useEffect(() => {
    if (teamAKey && teamBKey && teamAKey === teamBKey) {
      setTeamBKey(null);
    }
  }, [teamAKey, teamBKey]);

  /* ---------------------------------------------------------------------- *
   * Display helpers
   * ---------------------------------------------------------------------- */

  const displayOf = useMemo(() => {
    const poolMap = new Map(
      teamPool.map((team) => [team.key, team.display]),
    );

    return (key: string): string =>
      poolMap.get(key) ?? aliases[key] ?? key;
  }, [teamPool, aliases]);

  /* ---------------------------------------------------------------------- *
   * H2H
   * ---------------------------------------------------------------------- */

  const matchupSummary: MatchupSummary | null = useMemo(() => {
    if (!teamAKey || !teamBKey) return null;

    return summarizeMatchup(
      data.h2hPairs,
      teamAKey,
      teamBKey,
      displayOf,
    );
  }, [
    data.h2hPairs,
    teamAKey,
    teamBKey,
    displayOf,
  ]);

  /* ---------------------------------------------------------------------- *
   * Position history
   * ---------------------------------------------------------------------- */

  const positionHistory = useMemo<PositionHistoryPair | null>(() => {
    if (
      !teamAKey ||
      !teamBKey ||
      !scopedSelectedSeason
    ) {
      return null;
    }

    const history = computePositionHistory(
      scopedSelectedSeason,
      leagueWeights,
      aliases,
    );

    return {
      a:
        history.find((entry) => entry.key === teamAKey) ??
        null,
      b:
        history.find((entry) => entry.key === teamBKey) ??
        null,
    };
  }, [
    teamAKey,
    teamBKey,
    scopedSelectedSeason,
    leagueWeights,
    aliases,
  ]);

  /* ---------------------------------------------------------------------- *
   * Team matches
   *
   * IMPORTANT:
   * leagueMatches is already filtered above.
   *
   * Previously every memo repeated:
   *
   *   seasons.filter(...).flatMap(...)
   *
   * This was unnecessary work and made the dependency graph noisier.
   * ---------------------------------------------------------------------- */

  const teamAMatches = useMemo(
    () =>
      teamAKey
        ? computeTeamMatches(
            leagueMatches,
            teamAKey,
            aliases,
          )
        : null,
    [teamAKey, leagueMatches, aliases],
  );

  const teamBMatches = useMemo(
    () =>
      teamBKey
        ? computeTeamMatches(
            leagueMatches,
            teamBKey,
            aliases,
          )
        : null,
    [teamBKey, leagueMatches, aliases],
  );

  /* ---------------------------------------------------------------------- *
   * Result matrix
   * ---------------------------------------------------------------------- */

  const resultMatrix = useMemo(
    () =>
      matrixTeamKey
        ? computeResultMatrix(
            leagueMatches,
            matrixTeamKey,
            aliases,
          )
        : null,
    [matrixTeamKey, leagueMatches, aliases],
  );

  /* ---------------------------------------------------------------------- *
   * Page metadata
   * ---------------------------------------------------------------------- */

  const hasData = data.standings.length > 0;

  const seasonName =
    scopedSelectedSeason?.name ??
    `${LEAGUE_LABEL[currentLeague]} (összes szezon)`;

  const matchCount =
    scopedSelectedSeason?.matches.length ??
    data.overview.totalMatches;

  return (
    <div className="flex flex-col gap-4 md:gap-5">
      <PageHeader
        icon={BarChart3}
        title="Liga Elemző"
        intro={INTRO}
        eyebrow={`${LEAGUE_FLAG[currentLeague]} ${LEAGUE_LABEL[currentLeague]} · ${seasonName} · ${matchCount} mérkőzés`}
      />

      {!hasData ? (
        <Panel>
          <div className="px-5 py-16 text-center text-ui-sm text-muted-foreground">
            Nincs betöltött bajnokság. Tölts fel egy CSV fájlt a Taktikai
            Stúdióban.
          </div>
        </Panel>
      ) : (
        <>
          {/* 01 — LEAGUE OVERVIEW */}

          <SectionHeading
            icon={Trophy}
            hint={`${LEAGUE_LABEL[currentLeague]} · ${matchCount} meccs`}
          >
            01 — Liga Áttekintés
          </SectionHeading>

          <LeagueStandingsTable rows={data.standings} />

          <MetricGrid cols={5}>
            <MetricCard
              label="Gól / Meccs"
              value={data.overview.goalsPerMatch.toFixed(2)}
              sub={`Összes: ${data.overview.totalMatches}`}
              tone="signal"
            />

            <MetricCard
              label="Hazai Győzelem %"
              value={`${data.overview.homeWinPct.toFixed(1)}%`}
              tone="positive"
              sub={LEAGUE_LABEL[currentLeague]}
            />

            <MetricCard
              label="Döntetlen %"
              value={`${data.overview.drawPct.toFixed(1)}%`}
              tone="neutral"
              sub={LEAGUE_LABEL[currentLeague]}
            />

            <MetricCard
              label="Vendég Győzelem %"
              value={`${data.overview.awayWinPct.toFixed(1)}%`}
              tone="warning"
              sub={LEAGUE_LABEL[currentLeague]}
            />

            <MetricCard
              label="Over 2.5 %"
              value={`${data.overview.over25Pct.toFixed(1)}%`}
              tone="signal"
              sub={`BTTS: ${data.overview.bttsPct.toFixed(1)}%`}
            />
          </MetricGrid>

          <BenchmarkCard
            overview={data.overview}
            benchmark={data.benchmark}
            leagueLabel={LEAGUE_LABEL[currentLeague]}
          />

          <OutcomeDistribution overview={data.overview} />

          <FixturesPanel
            current={fixtures.current}
            next={fixtures.next}
          />

          {/* 02 — OVER / UNDER */}

          <SectionHeading
            icon={TrendingUp}
            hint="Csapatonkénti Over/Under 2.5"
          >
            02 — Over / Under Tábla
          </SectionHeading>

          <OverUnderTable rows={data.overUnder} />

          {/* 03 — FORM */}

          <SectionHeading
            icon={TrendingUp}
            hint="Utolsó 5 meccs alapján"
          >
            03 — Forma Tábla
          </SectionHeading>

          <FormTable rows={data.form} />

          {/* 04 — TEAM COMPARISON */}

          <SectionHeading
            icon={Swords}
            hint="Két csapat kiválasztása és összehasonlítása"
          >
            04 — Csapat Összehasonlítás
          </SectionHeading>

          <TeamComparisonSection
            teamPool={teamPool}
            teamAKey={teamAKey}
            teamBKey={teamBKey}
            onTeamAChange={setTeamAKey}
            onTeamBChange={setTeamBKey}
            standings={data.standings}
            overUnder={data.overUnder}
            form={data.form}
            matchupSummary={matchupSummary}
            positionHistory={positionHistory}
            displayOf={displayOf}
          />

          {/* 05 — TEAM MATCH HISTORY */}

          <SectionHeading
            icon={ListOrdered}
            hint="Csapatonkénti utolsó és következő meccsek"
          >
            05 — Csapat Meccs Történet
          </SectionHeading>

          <TeamMatchHistorySection
            teamAKey={teamAKey}
            teamBKey={teamBKey}
            teamAMatches={teamAMatches}
            teamBMatches={teamBMatches}
            displayOf={displayOf}
          />

          {/* 06 — RESULT MATRIX */}

          <SectionHeading
            icon={Grid3x3}
            hint="Egy csapat eredményei minden ellenfél ellen"
          >
            06 — Eredmény Mátrix
          </SectionHeading>

          <ResultMatrixSection
            teamPool={teamPool}
            matrixTeamKey={matrixTeamKey}
            onMatrixTeamChange={setMatrixTeamKey}
            resultMatrix={resultMatrix}
          />
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * League standings                                                            *
 * -------------------------------------------------------------------------- */

function LeagueStandingsTable({
  rows,
}: {
  rows: StandingRows;
}) {
  return (
    <Panel>
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelTitle>Tabella</PanelTitle>
          <PanelSubtitle>
            {rows.length} csapat · teljes sorrend
          </PanelSubtitle>
        </div>
      </PanelHeader>

      <TableScroll>
        <Table minWidth={720}>
          <colgroup>
            <col style={{ width: 44 }} />
            <col />
            <col style={{ width: 40 }} />
            <col style={{ width: 40 }} />
            <col style={{ width: 40 }} />
            <col style={{ width: 40 }} />
            <col style={{ width: 64 }} />
            <col style={{ width: 48 }} />
            <col style={{ width: 52 }} />
          </colgroup>

          <thead>
            <tr>
              <Th align="center">#</Th>
              <Th className="pl-4">Csapat</Th>
              <Th align="center">M</Th>
              <Th align="center">G</Th>
              <Th align="center">D</Th>
              <Th align="center">V</Th>
              <Th align="center">Gólok</Th>
              <Th align="center">GK</Th>
              <Th
                align="center"
                className="text-foreground"
              >
                Pont
              </Th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row, idx) => {
              const rank = idx + 1;
              const gd = row.gf - row.ga;

              return (
                <Tr key={row.key}>
                  <Td
                    align="center"
                    className="text-[13px] text-muted-foreground"
                  >
                    {rank}
                  </Td>

                  <TdLabel className="pl-4">
                    <span className="flex items-center gap-2.5">
                      <TeamBadge name={row.displayName} />
                      <span className="truncate text-[14px]">
                        {row.displayName}
                      </span>
                    </span>
                  </TdLabel>

                  <Td align="center">{row.played}</Td>
                  <Td align="center">{row.wins}</Td>
                  <Td align="center">{row.draws}</Td>
                  <Td align="center">{row.losses}</Td>
                  <Td align="center">
                    {row.gf}:{row.ga}
                  </Td>

                  <Td
                    align="center"
                    className={cn(
                      gd > 0
                        ? 'text-positive'
                        : gd < 0
                          ? 'text-negative'
                          : 'text-muted-foreground',
                    )}
                  >
                    {gd > 0 ? `+${gd}` : gd}
                  </Td>

                  <Td
                    align="center"
                    className="font-semibold text-foreground"
                  >
                    {row.points}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableScroll>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- *
 * Benchmark                                                                   *
 * -------------------------------------------------------------------------- */

function BenchmarkCard({
  overview,
  benchmark,
  leagueLabel,
}: {
  overview: ReturnType<typeof buildLeagueAnalyzerData>['overview'];
  benchmark: ReturnType<typeof buildLeagueAnalyzerData>['benchmark'];
  leagueLabel: string;
}) {
  const rows = [
    {
      label: 'Gól / Meccs',
      active: overview.goalsPerMatch.toFixed(2),
      bench: benchmark.goalsPerMatch.toFixed(2),
    },
    {
      label: 'Hazai Győzelem %',
      active: `${overview.homeWinPct.toFixed(1)}%`,
      bench: `${benchmark.homeWinPct.toFixed(1)}%`,
    },
    {
      label: 'Döntetlen %',
      active: `${overview.drawPct.toFixed(1)}%`,
      bench: `${benchmark.drawPct.toFixed(1)}%`,
    },
    {
      label: 'Vendég Győzelem %',
      active: `${overview.awayWinPct.toFixed(1)}%`,
      bench: `${benchmark.awayWinPct.toFixed(1)}%`,
    },
    {
      label: 'Over 2.5 %',
      active: `${overview.over25Pct.toFixed(1)}%`,
      bench: `${benchmark.over25Pct.toFixed(1)}%`,
    },
    {
      label: 'BTTS %',
      active: `${overview.bttsPct.toFixed(1)}%`,
      bench: `${benchmark.bttsPct.toFixed(1)}%`,
    },
  ];

  return (
    <Panel>
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelTitle>WinMix League Benchmark</PanelTitle>

          <PanelSubtitle>
            Aktív liga: {leagueLabel} vs. Benchmark: Angol + Spanyol (
            {benchmark.totalMatches} meccs)
          </PanelSubtitle>
        </div>
      </PanelHeader>

      <div className="overflow-x-auto">
        <table
          className="data-table"
          style={{ minWidth: 420 }}
        >
          <thead>
            <tr>
              <Th>Mutató</Th>
              <Th align="center">Aktív liga</Th>
              <Th align="center">Benchmark</Th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <Tr key={row.label}>
                <TdLabel className="pl-4">
                  {row.label}
                </TdLabel>

                <Td
                  align="center"
                  className="font-semibold text-foreground"
                >
                  {row.active}
                </Td>

                <Td
                  align="center"
                  className="text-muted-foreground"
                >
                  {row.bench}
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- *
 * Outcome distribution                                                        *
 * -------------------------------------------------------------------------- */

function OutcomeDistribution({
  overview,
}: {
  overview: ReturnType<typeof buildLeagueAnalyzerData>['overview'];
}) {
  const segments = [
    {
      label: 'Hazai győzelem',
      pct: overview.homeWinPct,
      color: 'bg-positive',
    },
    {
      label: 'Döntetlen',
      pct: overview.drawPct,
      color: 'bg-white/[0.12]',
    },
    {
      label: 'Vendég győzelem',
      pct: overview.awayWinPct,
      color: 'bg-warning',
    },
  ];

  return (
    <Panel>
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelTitle>Eredmény Megoszlás</PanelTitle>
          <PanelSubtitle>
            Összes lejátszott meccs kimenetele
          </PanelSubtitle>
        </div>
      </PanelHeader>

      <div className="px-5 py-4">
        <div className="flex h-8 w-full overflow-hidden rounded-lg">
          {segments.map((segment) => (
            <div
              key={segment.label}
              className={cn(
                'flex items-center justify-center text-ui-xs font-medium text-foreground transition-all',
                segment.color,
              )}
              style={{
                width: `${segment.pct}%`,
              }}
              title={`${segment.label}: ${segment.pct.toFixed(1)}%`}
            >
              {segment.pct > 8
                ? `${segment.pct.toFixed(0)}%`
                : ''}
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {segments.map((segment) => (
            <div
              key={segment.label}
              className="flex items-center gap-2 text-ui-xs"
            >
              <span
                className={cn(
                  'h-2.5 w-2.5 rounded-sm',
                  segment.color,
                )}
                aria-hidden="true"
              />

              <span className="text-muted-foreground">
                {segment.label}
              </span>

              <span className="font-medium tabular-nums text-foreground">
                {segment.pct.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- *
 * Fixtures                                                                    *
 * -------------------------------------------------------------------------- */

function FixturesPanel({
  current,
  next,
}: {
  current: FixtureEntry[];
  next: FixtureEntry[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel>
        <PanelHeader>
          <div className="flex flex-col gap-0.5">
            <PanelTitle>
              Utolsó Forduló Eredmények
            </PanelTitle>

            <PanelSubtitle>
              {current.length > 0
                ? `${current.length} meccs`
                : 'Nincs adat'}
            </PanelSubtitle>
          </div>
        </PanelHeader>

        <div className="divide-y divide-border-subtle">
          {current.length === 0 ? (
            <div className="px-5 py-8 text-center text-ui-xs text-muted-foreground">
              Nincs rendelkezésre álló lejátszott mérkőzés.
            </div>
          ) : (
            current.map((fixture, index) => (
              <FixtureRow
                key={`${fixture.homeTeam}-${fixture.awayTeam}-${index}`}
                fixture={fixture}
              />
            ))
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHeader>
          <div className="flex flex-col gap-0.5">
            <PanelTitle>Következő Forduló</PanelTitle>

            <PanelSubtitle>
              {next.length > 0
                ? `${next.length} meccs`
                : 'Nincs adat'}
            </PanelSubtitle>
          </div>
        </PanelHeader>

        <div className="divide-y divide-border-subtle">
          {next.length === 0 ? (
            <div className="px-5 py-8 text-center text-ui-xs text-muted-foreground">
              Nincs rendelkezésre álló jövőbeli mérkőzés.
            </div>
          ) : (
            next.map((fixture, index) => (
              <FixtureRow
                key={`${fixture.homeTeam}-${fixture.awayTeam}-${index}`}
                fixture={fixture}
              />
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}

function FixtureRow({
  fixture,
}: {
  fixture: FixtureEntry;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5 text-ui-sm">
      <span className="text-ui-xs text-muted-foreground tabular-nums">
        {fixture.date || '—'}
      </span>

      <div className="flex items-center gap-2">
        <span className="text-right text-foreground">
          {fixture.homeTeam}
        </span>

        {fixture.isUpcoming ? (
          <span className="text-muted-foreground">
            —
          </span>
        ) : (
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-ui-xs tabular-nums text-foreground">
            {fixture.homeScore} : {fixture.awayScore}
          </span>
        )}

        <span className="text-foreground">
          {fixture.awayTeam}
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Over / Under                                                                *
 * -------------------------------------------------------------------------- */

function OverUnderTable({
  rows,
}: {
  rows: TeamOverUnderRow[];
}) {
  return (
    <Panel>
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelTitle>
            Over / Under 2.5 — Csapatonként
          </PanelTitle>

          <PanelSubtitle>
            {rows.length} csapat · Over 2.5 % szerint csökkenő
          </PanelSubtitle>
        </div>
      </PanelHeader>

      <TableScroll>
        <Table minWidth={560}>
          <thead>
            <tr>
              <Th align="center">#</Th>
              <Th className="pl-4">Csapat</Th>
              <Th align="center">M</Th>
              <Th align="center">Over 2.5 %</Th>
              <Th align="center">Under 2.5 %</Th>
              <Th align="center">Over 1.5 %</Th>
              <Th align="center">BTTS %</Th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row, index) => (
              <Tr key={row.key}>
                <Td
                  align="center"
                  className="text-[13px] text-muted-foreground"
                >
                  {index + 1}
                </Td>

                <TdLabel className="pl-4">
                  <span className="flex items-center gap-2.5">
                    <TeamBadge name={row.displayName} />

                    <span className="truncate text-[14px]">
                      {row.displayName}
                    </span>
                  </span>
                </TdLabel>

                <Td align="center">
                  {row.played}
                </Td>

                <Td
                  align="center"
                  className="font-semibold text-signal"
                >
                  {row.over25Pct.toFixed(1)}%
                </Td>

                <Td
                  align="center"
                  className="text-muted-foreground"
                >
                  {row.under25Pct.toFixed(1)}%
                </Td>

                <Td align="center">
                  {row.over15Pct.toFixed(1)}%
                </Td>

                <Td align="center">
                  {row.bttsPct.toFixed(1)}%
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- *
 * Form                                                                        *
 * -------------------------------------------------------------------------- */

function FormTable({
  rows,
}: {
  rows: TeamFormRow[];
}) {
  return (
    <Panel>
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelTitle>
            Forma Tábla — Utolsó 5 Meccs
          </PanelTitle>

          <PanelSubtitle>
            {rows.length} csapat · Forma pontszám szerint csökkenő
          </PanelSubtitle>
        </div>
      </PanelHeader>

      <TableScroll>
        <Table minWidth={520}>
          <thead>
            <tr>
              <Th align="center">#</Th>
              <Th className="pl-4">Csapat</Th>
              <Th align="center">M</Th>
              <Th align="center">Forma (utolsó 5)</Th>
              <Th align="center">Forma Pont</Th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row, index) => (
              <Tr key={row.key}>
                <Td
                  align="center"
                  className="text-[13px] text-muted-foreground"
                >
                  {index + 1}
                </Td>

                <TdLabel className="pl-4">
                  <span className="flex items-center gap-2.5">
                    <TeamBadge name={row.displayName} />

                    <span className="truncate text-[14px]">
                      {row.displayName}
                    </span>
                  </span>
                </TdLabel>

                <Td align="center">
                  {row.played}
                </Td>

                <Td align="center">
                  <div className="flex items-center justify-center gap-1">
                    {row.form.length === 0 ? (
                      <span className="text-ui-xs text-muted-foreground">
                        —
                      </span>
                    ) : (
                      row.form.map((result, resultIndex) => (
                        <span
                          key={`${row.key}-${resultIndex}`}
                          className={cn(
                            'flex h-6 w-6 items-center justify-center rounded text-ui-xs font-semibold',
                            FORM_COLORS[result],
                          )}
                        >
                          {formLabel(result)}
                        </span>
                      ))
                    )}
                  </div>
                </Td>

                <Td
                  align="center"
                  className="font-semibold text-foreground"
                >
                  {row.formPoints}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- *
 * Team comparison                                                             *
 * -------------------------------------------------------------------------- */

function TeamComparisonSection({
  teamPool,
  teamAKey,
  teamBKey,
  onTeamAChange,
  onTeamBChange,
  standings,
  overUnder,
  form,
  matchupSummary,
  positionHistory,
  displayOf,
}: {
  teamPool: TeamPoolRow[];
  teamAKey: string | null;
  teamBKey: string | null;
  onTeamAChange: (key: string | null) => void;
  onTeamBChange: (key: string | null) => void;
  standings: StandingRows;
  overUnder: TeamOverUnderRow[];
  form: TeamFormRow[];
  matchupSummary: MatchupSummary | null;
  positionHistory: PositionHistoryPair | null;
  displayOf: (key: string) => string;
}) {
  const getStanding = (key: string | null) => {
    if (!key) return null;

    const index = standings.findIndex(
      (standing) => standing.key === key,
    );

    if (index < 0) return null;

    return {
      row: standings[index],
      rank: index + 1,
    };
  };

  const getOU = (key: string | null) =>
    overUnder.find((item) => item.key === key) ?? null;

  const getForm = (key: string | null) =>
    form.find((item) => item.key === key) ?? null;

  const aStanding = getStanding(teamAKey);
  const bStanding = getStanding(teamBKey);

  const aOU = getOU(teamAKey);
  const bOU = getOU(teamBKey);

  const aForm = getForm(teamAKey);
  const bForm = getForm(teamBKey);

  const compareRow = (
    label: string,
    aVal: string,
    bVal: string,
    aBetter: boolean | null = null,
  ) => (
    <tr key={label}>
      <TdLabel className="pl-4">
        {label}
      </TdLabel>

      <Td
        align="center"
        className={cn(
          'font-semibold',
          aBetter === true
            ? 'text-positive'
            : aBetter === false
              ? 'text-negative'
              : 'text-foreground',
        )}
      >
        {aVal}
      </Td>

      <Td
        align="center"
        className={cn(
          'font-semibold',
          aBetter === false
            ? 'text-positive'
            : aBetter === true
              ? 'text-negative'
              : 'text-foreground',
        )}
      >
        {bVal}
      </Td>
    </tr>
  );

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader>
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-end">
            <TeamSelect
              label="Csapat A"
              value={teamAKey}
              teamPool={teamPool}
              excludeKey={teamBKey}
              onChange={onTeamAChange}
              ariaLabel="Csapat A kiválasztása"
            />

            <TeamSelect
              label="Csapat B"
              value={teamBKey}
              teamPool={teamPool}
              excludeKey={teamAKey}
              onChange={onTeamBChange}
              ariaLabel="Csapat B kiválasztása"
            />
          </div>
        </PanelHeader>
      </Panel>

      {teamAKey && teamBKey ? (
        <>
          {/* Side-by-side metrics */}

          <Panel>
            <PanelHeader>
              <div className="flex flex-col gap-0.5">
                <PanelTitle>
                  Összehasonlítás — {displayOf(teamAKey)} vs{' '}
                  {displayOf(teamBKey)}
                </PanelTitle>

                <PanelSubtitle>
                  Főbb mutatók egymás mellett
                </PanelSubtitle>
              </div>
            </PanelHeader>

            <div className="overflow-x-auto">
              <table
                className="data-table"
                style={{ minWidth: 480 }}
              >
                <thead>
                  <tr>
                    <Th>Mutató</Th>
                    <Th align="center">
                      {displayOf(teamAKey)}
                    </Th>
                    <Th align="center">
                      {displayOf(teamBKey)}
                    </Th>
                  </tr>
                </thead>

                <tbody>
                  {compareRow(
                    'Tabella helyezés',
                    aStanding ? `${aStanding.rank}.` : '—',
                    bStanding ? `${bStanding.rank}.` : '—',
                    aStanding && bStanding
                      ? aStanding.rank < bStanding.rank
                      : null,
                  )}

                  {compareRow(
                    'Pontszám',
                    aStanding
                      ? String(aStanding.row.points)
                      : '—',
                    bStanding
                      ? String(bStanding.row.points)
                      : '—',
                    aStanding && bStanding
                      ? aStanding.row.points >
                        bStanding.row.points
                      : null,
                  )}

                  {compareRow(
                    'Győzelmek',
                    aStanding
                      ? String(aStanding.row.wins)
                      : '—',
                    bStanding
                      ? String(bStanding.row.wins)
                      : '—',
                    aStanding && bStanding
                      ? aStanding.row.wins >
                        bStanding.row.wins
                      : null,
                  )}

                  {compareRow(
                    'Lőtt gól / meccs',
                    aStanding && aStanding.row.played > 0
                      ? (
                          aStanding.row.gf /
                          aStanding.row.played
                        ).toFixed(2)
                      : '—',
                    bStanding && bStanding.row.played > 0
                      ? (
                          bStanding.row.gf /
                          bStanding.row.played
                        ).toFixed(2)
                      : '—',
                  )}

                  {compareRow(
                    'Kapott gól / meccs',
                    aStanding && aStanding.row.played > 0
                      ? (
                          aStanding.row.ga /
                          aStanding.row.played
                        ).toFixed(2)
                      : '—',
                    bStanding && bStanding.row.played > 0
                      ? (
                          bStanding.row.ga /
                          bStanding.row.played
                        ).toFixed(2)
                      : '—',
                  )}

                  {compareRow(
                    'Over 2.5 %',
                    aOU
                      ? `${aOU.over25Pct.toFixed(1)}%`
                      : '—',
                    bOU
                      ? `${bOU.over25Pct.toFixed(1)}%`
                      : '—',
                    aOU && bOU
                      ? aOU.over25Pct > bOU.over25Pct
                      : null,
                  )}

                  {compareRow(
                    'BTTS %',
                    aOU
                      ? `${aOU.bttsPct.toFixed(1)}%`
                      : '—',
                    bOU
                      ? `${bOU.bttsPct.toFixed(1)}%`
                      : '—',
                  )}

                  {compareRow(
                    'Forma pont (utolsó 5)',
                    aForm
                      ? String(aForm.formPoints)
                      : '—',
                    bForm
                      ? String(bForm.formPoints)
                      : '—',
                    aForm && bForm
                      ? aForm.formPoints >
                        bForm.formPoints
                      : null,
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* H2H summary */}

          {matchupSummary &&
          matchupSummary.played > 0 ? (
            <Panel>
              <PanelHeader>
                <div className="flex flex-col gap-0.5">
                  <PanelTitle>
                    Egymás Ellen (H2H)
                  </PanelTitle>

                  <PanelSubtitle>
                    {matchupSummary.played} meccs ·{' '}
                    {displayOf(teamAKey)} szemszögéből
                  </PanelSubtitle>
                </div>
              </PanelHeader>

              <div className="grid grid-cols-3 gap-px bg-border-subtle">
                <H2HStat
                  label={`${displayOf(teamAKey)} győzelem`}
                  value={matchupSummary.aWins}
                  pct={
                    (matchupSummary.aWins /
                      matchupSummary.played) *
                    100
                  }
                  tone="positive"
                />

                <H2HStat
                  label="Döntetlen"
                  value={matchupSummary.draws}
                  pct={
                    (matchupSummary.draws /
                      matchupSummary.played) *
                    100
                  }
                  tone="neutral"
                />

                <H2HStat
                  label={`${displayOf(teamBKey)} győzelem`}
                  value={matchupSummary.bWins}
                  pct={
                    (matchupSummary.bWins /
                      matchupSummary.played) *
                    100
                  }
                  tone="negative"
                />
              </div>

              <div className="grid grid-cols-3 gap-px border-t border-border-subtle bg-border-subtle">
                <H2HStat
                  label="Átlag gól"
                  value={matchupSummary.avgGoals.toFixed(1)}
                  pct={0}
                  tone="signal"
                  showPct={false}
                />

                <H2HStat
                  label="BTTS %"
                  value={`${matchupSummary.bttsPct.toFixed(0)}%`}
                  pct={matchupSummary.bttsPct}
                  tone="signal"
                  showPct={false}
                />

                <H2HStat
                  label="Over 2.5 %"
                  value={`${matchupSummary.over25Pct.toFixed(0)}%`}
                  pct={matchupSummary.over25Pct}
                  tone="signal"
                  showPct={false}
                />
              </div>
            </Panel>
          ) : (
            <Panel>
              <div className="px-5 py-8 text-center text-ui-sm text-muted-foreground">
                Nincs közvetlen H2H mérkőzés a két csapat között a
                betöltött adatokban.
              </div>
            </Panel>
          )}

          {/* Recent H2H */}

          {matchupSummary &&
          matchupSummary.matches.length > 0 ? (
            <Panel>
              <PanelHeader>
                <div className="flex flex-col gap-0.5">
                  <PanelTitle>
                    Legutóbbi H2H Mérkőzések
                  </PanelTitle>

                  <PanelSubtitle>
                    {matchupSummary.matches.length} találkozó
                  </PanelSubtitle>
                </div>
              </PanelHeader>

              <TableScroll>
                <Table minWidth={480}>
                  <thead>
                    <tr>
                      <Th>Dátum</Th>
                      <Th>Hazai</Th>
                      <Th align="center">
                        Eredmény
                      </Th>
                      <Th>Vendég</Th>
                    </tr>
                  </thead>

                  <tbody>
                    {matchupSummary.matches
                      .slice(0, 10)
                      .map((match, index) => (
                        <Tr
                          key={`${match.date}-${match.home_team}-${match.away_team}-${index}`}
                        >
                          <Td className="text-ui-xs text-muted-foreground">
                            {match.date || '—'}
                          </Td>

                          <TdLabel>
                            {match.home_team}
                          </TdLabel>

                          <Td
                            align="center"
                            className="font-semibold"
                          >
                            {match.home_score} :{' '}
                            {match.away_score}
                          </Td>

                          <TdLabel>
                            {match.away_team}
                          </TdLabel>
                        </Tr>
                      ))}
                  </tbody>
                </Table>
              </TableScroll>
            </Panel>
          ) : null}

          {/* Position history */}

          {positionHistory &&
          (positionHistory.a ||
            positionHistory.b) ? (
            <Panel>
              <PanelHeader>
                <div className="flex flex-col gap-0.5">
                  <PanelTitle>
                    Helyezés Alakulás
                  </PanelTitle>

                  <PanelSubtitle>
                    Tabellapozíció fordulónként
                  </PanelSubtitle>
                </div>
              </PanelHeader>

              <div className="px-5 py-4">
                <PositionChart
                  a={positionHistory.a}
                  b={positionHistory.b}
                  aLabel={displayOf(teamAKey)}
                  bLabel={displayOf(teamBKey)}
                />
              </div>
            </Panel>
          ) : null}

          {/* Over / Under comparison */}

          {aOU && bOU ? (
            <Panel>
              <PanelHeader>
                <div className="flex flex-col gap-0.5">
                  <PanelTitle>
                    Over / Under Összehasonlítás
                  </PanelTitle>

                  <PanelSubtitle>
                    2.5 gól feletti/alatti meccsek megoszlása
                  </PanelSubtitle>
                </div>
              </PanelHeader>

              <div className="overflow-x-auto">
                <table
                  className="data-table"
                  style={{ minWidth: 360 }}
                >
                  <thead>
                    <tr>
                      <Th>Mutató</Th>
                      <Th align="center">
                        {displayOf(teamAKey)}
                      </Th>
                      <Th align="center">
                        {displayOf(teamBKey)}
                      </Th>
                    </tr>
                  </thead>

                  <tbody>
                    <Tr>
                      <TdLabel className="pl-4">
                        Over 2.5 %
                      </TdLabel>

                      <Td
                        align="center"
                        className="font-semibold text-signal"
                      >
                        {aOU.over25Pct.toFixed(1)}%
                      </Td>

                      <Td
                        align="center"
                        className="font-semibold text-signal"
                      >
                        {bOU.over25Pct.toFixed(1)}%
                      </Td>
                    </Tr>

                    <Tr>
                      <TdLabel className="pl-4">
                        Under 2.5 %
                      </TdLabel>

                      <Td align="center">
                        {aOU.under25Pct.toFixed(1)}%
                      </Td>

                      <Td align="center">
                        {bOU.under25Pct.toFixed(1)}%
                      </Td>
                    </Tr>

                    <Tr>
                      <TdLabel className="pl-4">
                        BTTS %
                      </TdLabel>

                      <Td align="center">
                        {aOU.bttsPct.toFixed(1)}%
                      </Td>

                      <Td align="center">
                        {bOU.bttsPct.toFixed(1)}%
                      </Td>
                    </Tr>
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
        </>
      ) : (
        <Panel>
          <div className="px-5 py-10 text-center text-ui-sm text-muted-foreground">
            Válassz két különböző csapatot az összehasonlításhoz.
          </div>
        </Panel>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Team select                                                                 *
 * -------------------------------------------------------------------------- */

function TeamSelect({
  label,
  value,
  teamPool,
  excludeKey,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: string | null;
  teamPool: TeamPoolRow[];
  excludeKey: string | null;
  onChange: (key: string | null) => void;
  ariaLabel: string;
}) {
  const availableTeams = useMemo(
    () =>
      teamPool.filter(
        (team) => team.key !== excludeKey,
      ),
    [teamPool, excludeKey],
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label className="text-ui-xs text-muted-foreground">
        {label}
      </label>

      <select
        value={value ?? ''}
        onChange={(event) =>
          onChange(event.target.value || null)
        }
        aria-label={ariaLabel}
        disabled={teamPool.length === 0}
        className={cn(
          'h-9 w-full rounded-lg border border-border bg-surface-1 px-3 text-ui-sm text-foreground outline-none transition-colors',
          'focus:border-signal focus:ring-1 focus:ring-signal/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <option value="">
          {teamPool.length === 0
            ? '— Nincs csapat —'
            : '— Válassz csapatot —'}
        </option>

        {availableTeams.map((team) => (
          <option
            key={team.key}
            value={team.key}
          >
            {team.display}
          </option>
        ))}
      </select>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * H2H stat                                                                    *
 * -------------------------------------------------------------------------- */

function H2HStat({
  label,
  value,
  pct,
  tone,
  showPct = true,
}: {
  label: string;
  value: React.ReactNode;
  pct: number;
  tone:
    | 'positive'
    | 'neutral'
    | 'negative'
    | 'signal';
  showPct?: boolean;
}) {
  const toneClass = {
    positive: 'text-positive',
    neutral: 'text-muted-foreground',
    negative: 'text-negative',
    signal: 'text-signal',
  };

  return (
    <div className="bg-card px-4 py-3 text-center">
      <div
        className={cn(
          'text-data-base font-semibold tabular-nums',
          toneClass[tone],
        )}
      >
        {value}
      </div>

      <div className="mt-0.5 text-ui-xs text-muted-foreground">
        {label}
      </div>

      {showPct ? (
        <div className="mt-0.5 text-ui-xs tabular-nums text-muted-foreground">
          {pct.toFixed(0)}%
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Position chart                                                              *
 * -------------------------------------------------------------------------- */

function PositionChart({
  a,
  b,
  aLabel,
  bLabel,
}: {
  a: PositionHistoryTeam | null;
  b: PositionHistoryTeam | null;
  aLabel: string;
  bLabel: string;
}) {
  const maxRound = Math.max(
    a?.history.length ?? 0,
    b?.history.length ?? 0,
  );

  if (maxRound === 0) {
    return (
      <div className="py-6 text-center text-ui-sm text-muted-foreground">
        Nincs elérhető helyezés-adat.
      </div>
    );
  }

  const maxPos = Math.max(
    ...(a?.history.map((item) => item.position) ?? []),
    ...(b?.history.map((item) => item.position) ?? []),
    1,
  );

  /*
   * FIX:
   *
   * The old formula:
   *
   *   h.round * (100 / maxRound)
   *
   * produced x=100 for the final point and becomes problematic when the
   * chart contains only one round.
   *
   * For one point we deliberately place it at 50%.
   * For multiple points we use the complete 0..100 chart width.
   */
  const xForRound = (round: number): number => {
    if (maxRound <= 1) {
      return 50;
    }

    return ((round - 1) / (maxRound - 1)) * 100;
  };

  /*
   * Position 1 should be visually at the top.
   *
   * The denominator is protected against zero even for malformed data.
   */
  const yForPosition = (position: number): number => {
    const denominator = Math.max(maxPos, 1);

    if (denominator === 1) {
      return 50;
    }

    return ((position - 1) / (denominator - 1)) * 100;
  };

  const toPoints = (
    history: PositionHistoryTeam['history'],
  ): string =>
    history
      .map(
        (item) =>
          `${xForRound(item.round)},${yForPosition(
            item.position,
          )}`,
      )
      .join(' ');

  const aPoints = a
    ? toPoints(a.history)
    : '';

  const bPoints = b
    ? toPoints(b.history)
    : '';

  return (
    <div>
      <div className="relative h-48 w-full overflow-hidden rounded-lg border border-border-subtle bg-surface-1">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label="Tabellapozíció alakulása fordulónként"
        >
          {aPoints ? (
            <polyline
              points={aPoints}
              fill="none"
              stroke="var(--signal)"
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {bPoints ? (
            <polyline
              points={bPoints}
              fill="none"
              stroke="var(--warning)"
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {a?.history.map((item) => (
            <circle
              key={`a-${item.round}`}
              cx={xForRound(item.round)}
              cy={yForPosition(item.position)}
              r={1}
              fill="var(--signal)"
            />
          ))}

          {b?.history.map((item) => (
            <circle
              key={`b-${item.round}`}
              cx={xForRound(item.round)}
              cy={yForPosition(item.position)}
              r={1}
              fill="var(--warning)"
            />
          ))}
        </svg>

        <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1">
          {a ? (
            <div className="flex items-center gap-1.5 text-ui-xs">
              <span className="h-0.5 w-4 bg-signal" />
              <span className="text-foreground">
                {aLabel}
              </span>
            </div>
          ) : null}

          {b ? (
            <div className="flex items-center gap-1.5 text-ui-xs">
              <span className="h-0.5 w-4 bg-warning" />
              <span className="text-foreground">
                {bLabel}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex justify-between text-ui-xs text-muted-foreground">
        <span>
          {maxRound === 1
            ? '1. forduló'
            : '1. forduló'}
        </span>

        <span>
          {maxRound}. forduló
        </span>
      </div>

      <div className="mt-1 text-ui-xs text-muted-foreground">
        <span className="mr-2">
          Felül = 1. hely
        </span>

        <span>
          Alul = {maxPos}. hely
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Team match history                                                          *
 * -------------------------------------------------------------------------- */

function TeamMatchHistorySection({
  teamAKey,
  teamBKey,
  teamAMatches,
  teamBMatches,
  displayOf,
}: {
  teamAKey: string | null;
  teamBKey: string | null;
  teamAMatches:
    | {
        previous: TeamMatchEntry[];
        upcoming: TeamMatchEntry[];
      }
    | null;
  teamBMatches:
    | {
        previous: TeamMatchEntry[];
        upcoming: TeamMatchEntry[];
      }
    | null;
  displayOf: (key: string) => string;
}) {
  if (!teamAKey && !teamBKey) {
    return (
      <Panel>
        <div className="px-5 py-10 text-center text-ui-sm text-muted-foreground">
          Válassz csapatokat az összehasonlításban fent a
          meccs-történet megtekintéséhez.
        </div>
      </Panel>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {teamAKey ? (
        <TeamMatchColumn
          title={displayOf(teamAKey)}
          matches={teamAMatches}
        />
      ) : null}

      {teamBKey ? (
        <TeamMatchColumn
          title={displayOf(teamBKey)}
          matches={teamBMatches}
        />
      ) : null}
    </div>
  );
}

function TeamMatchColumn({
  title,
  matches,
}: {
  title: string;
  matches:
    | {
        previous: TeamMatchEntry[];
        upcoming: TeamMatchEntry[];
      }
    | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <PanelHeader>
          <div className="flex flex-col gap-0.5">
            <PanelTitle as="h3">
              {title} — Legutóbbi Meccsek
            </PanelTitle>

            <PanelSubtitle>
              {matches?.previous.length ?? 0} eredmény
            </PanelSubtitle>
          </div>
        </PanelHeader>

        <div className="divide-y divide-border-subtle">
          {!matches ||
          matches.previous.length === 0 ? (
            <div className="px-5 py-6 text-center text-ui-xs text-muted-foreground">
              Nincs rendelkezésre álló lejátszott mérkőzés.
            </div>
          ) : (
            matches.previous.map((match, index) => (
              <TeamMatchRow
                key={`${match.date}-${match.opponentKey}-${index}`}
                match={match}
              />
            ))
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHeader>
          <div className="flex flex-col gap-0.5">
            <PanelTitle as="h3">
              {title} — Következő Meccsek
            </PanelTitle>

            <PanelSubtitle>
              {matches?.upcoming.length ?? 0} párosítás
            </PanelSubtitle>
          </div>
        </PanelHeader>

        <div className="divide-y divide-border-subtle">
          {!matches ||
          matches.upcoming.length === 0 ? (
            <div className="px-5 py-6 text-center text-ui-xs text-muted-foreground">
              Nincs rendelkezésre álló jövőbeli mérkőzés.
            </div>
          ) : (
            matches.upcoming.map((match, index) => (
              <TeamMatchRow
                key={`${match.date}-${match.opponentKey}-${index}`}
                match={match}
              />
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}

function TeamMatchRow({
  match,
}: {
  match: TeamMatchEntry;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5 text-ui-sm">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded text-ui-xs font-medium',
            match.isHome
              ? 'bg-signal-soft text-signal'
              : 'bg-white/[0.06] text-muted-foreground',
          )}
        >
          {match.isHome ? 'H' : 'I'}
        </span>

        <span className="text-foreground">
          {match.opponent}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-ui-xs text-muted-foreground tabular-nums">
          {match.date || '—'}
        </span>

        {!match.isUpcoming ? (
          <>
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-ui-xs tabular-nums text-foreground">
              {match.isHome
                ? `${match.homeScore}:${match.awayScore}`
                : `${match.awayScore}:${match.homeScore}`}
            </span>

            <span
              className={cn(
                'text-ui-xs',
                match.over25
                  ? 'text-signal'
                  : 'text-muted-foreground',
              )}
            >
              {match.over25
                ? 'O2.5'
                : 'U2.5'}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Result matrix                                                               *
 * -------------------------------------------------------------------------- */

function ResultMatrixSection({
  teamPool,
  matrixTeamKey,
  onMatrixTeamChange,
  resultMatrix,
}: {
  teamPool: TeamPoolRow[];
  matrixTeamKey: string | null;
  onMatrixTeamChange: (key: string | null) => void;
  resultMatrix: ReturnType<
    typeof computeResultMatrix
  > | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <TeamSelect
              label="Csapat kiválasztása"
              value={matrixTeamKey}
              teamPool={teamPool}
              excludeKey={null}
              onChange={onMatrixTeamChange}
              ariaLabel="Eredménymátrix csapat kiválasztása"
            />

            {resultMatrix ? (
              <span className="text-ui-xs text-muted-foreground">
                {resultMatrix.teamName} —{' '}
                {resultMatrix.rows.length} ellenfél
              </span>
            ) : null}
          </div>
        </PanelHeader>
      </Panel>

      {resultMatrix &&
      resultMatrix.rows.length > 0 ? (
        <Panel>
          <TableScroll>
            <Table minWidth={480}>
              <thead>
                <tr>
                  <Th className="pl-4">
                    Ellenfél
                  </Th>

                  <Th align="center">
                    Hazai eredmény
                  </Th>

                  <Th align="center">
                    Idegenbeli eredmény
                  </Th>
                </tr>
              </thead>

              <tbody>
                {resultMatrix.rows.map((row) => (
                  <Tr key={row.opponentKey}>
                    <TdLabel className="pl-4">
                      <span className="flex items-center gap-2">
                        <TeamBadge
                          name={row.opponentName}
                        />

                        <span className="truncate">
                          {row.opponentName}
                        </span>
                      </span>
                    </TdLabel>

                    <Td align="center">
                      <MatrixCell cell={row.home} />
                    </Td>

                    <Td align="center">
                      <MatrixCell cell={row.away} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Panel>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Matrix cell                                                                 *
 * -------------------------------------------------------------------------- */

function MatrixCell({
  cell,
}: {
  cell: ResultMatrixCell | null;
}) {
  if (!cell) {
    return (
      <span className="text-ui-xs text-muted-foreground">
        —
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-ui-xs font-medium tabular-nums',
        cellBg(cell.outcome),
        outcomeColor(cell.outcome),
      )}
    >
      {cell.homeScore} : {cell.awayScore}
    </span>
  );
}
