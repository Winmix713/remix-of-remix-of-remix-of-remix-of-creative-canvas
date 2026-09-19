/**
 * GeneratorStructurePanel — the read-only Generator Structure Suite surface.
 *
 * Runs the five statistical tests (Form, Stationarity, Home Advantage, H2H,
 * Goal Distribution) per league and renders their conclusions, effect sizes,
 * OOS deltas, model implications, and the BH multiplicity ledger.
 *
 * The suite never modifies any configuration; every implication row carries
 * automaticConfigurationChange = false.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Beaker, Download, Loader2, Play, AlertTriangle } from 'lucide-react';
import type { League, Season } from '../../types/winmix';
import { LEAGUE_LABEL } from '../../data/leagues';
import {
  runGeneratorSuite,
  generatorReportToJson,
  generatorReportFileName,
  completedTestCount,
} from '../../utils/generator/report';
import type { GeneratorReport, GeneratorSuiteOptions } from '../../utils/generator/report';
import type { TestResult, Conclusion, ModelImplication } from '../../utils/generator/types';
import type { GeneratorWorkerRequest, GeneratorWorkerResponse } from '../../workers/generator.worker';
import { Collapsible } from './Collapsible';
import { SectionHeading } from './Panel';
import { EmptyRow, Table, TableScroll, Td, Th, Tr } from './DataTable';
import { cn } from '../../lib/utils';

type RunState = 'idle' | 'running' | 'done' | 'error';

const conclusionTone: Record<Conclusion, string> = {
  COMPATIBLE: 'bg-positive-soft text-positive',
  INCOMPATIBLE: 'bg-negative-soft text-negative',
  INCONCLUSIVE: 'bg-white/[0.06] text-muted-foreground',
};

const conclusionLabel: Record<Conclusion, string> = {
  COMPATIBLE: 'Kompatibilis',
  INCOMPATIBLE: 'Nem kompatibilis',
  INCONCLUSIVE: 'Nincs döntés',
};

const implicationTone: Record<string, string> = {
  KEEP: 'bg-positive-soft text-positive',
  REMOVE: 'bg-negative-soft text-negative',
  INCONCLUSIVE: 'bg-white/[0.06] text-muted-foreground',
};

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-sm px-1.5 py-0.5 text-ui-xs tabular-nums', className)}>
      {children}
    </span>
  );
}

function formatEffect(e: { estimate: number; ci95Low: number; ci95High: number }): string {
  return `${e.estimate.toFixed(4)} [${e.ci95Low.toFixed(4)}, ${e.ci95High.toFixed(4)}]`;
}

function formatPValue(p: number | undefined): string {
  if (p === undefined) return '—';
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

function TestResultCard({
  title,
  result,
  children,
}: {
  title: string;
  result: TestResult;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-1/50 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-ui-sm font-medium text-foreground">{title}</h4>
        <Badge className={conclusionTone[result.conclusion]}>
          {conclusionLabel[result.conclusion]}
        </Badge>
      </div>
      <p className="mt-1.5 text-ui-xs text-muted-foreground">{result.rationale}</p>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5 text-ui-xs tabular-nums text-muted-foreground">
        <span>
          <span className="text-foreground/70">{result.effectLabel}:</span>{' '}
          {formatEffect(result.effect)}
        </span>
        {result.rawPValue !== undefined && (
          <span>
            <span className="text-foreground/70">nyers p:</span>{' '}
            {formatPValue(result.rawPValue)}
          </span>
        )}
        {result.adjustedPValue !== undefined && (
          <span>
            <span className="text-foreground/70">BH-korrigált p:</span>{' '}
            {formatPValue(result.adjustedPValue)}
          </span>
        )}
        {result.oosDeltaBrier !== undefined && (
          <span>
            <span className="text-foreground/70">OOS ΔBrier:</span>{' '}
            {result.oosDeltaBrier.toFixed(4)}
          </span>
        )}
        {result.oosDeltaLogLoss !== undefined && (
          <span>
            <span className="text-foreground/70">OOS ΔLogLoss:</span>{' '}
            {result.oosDeltaLogLoss.toFixed(4)}
          </span>
        )}
        <span>
          <span className="text-foreground/70">minta:</span> {result.sampleSize}
        </span>
      </div>
      {children}
    </div>
  );
}

export function GeneratorStructurePanel({
  seasons,
  league,
}: {
  seasons: Season[];
  league: League;
}) {
  const [state, setState] = useState<RunState>('idle');
  const [report, setReport] = useState<GeneratorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runMode, setRunMode] = useState<'worker' | 'inline'>('inline');
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  const leagueSeasons = seasons.filter((s) => s.league === league);

  const runInline = useCallback(() => {
    setState('running');
    setError(null);
    try {
      const result = runGeneratorSuite(leagueSeasons, league);
      setReport(result);
      setRunMode('inline');
      setState('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [leagueSeasons, league]);

  const runViaWorker = useCallback(() => {
    setState('running');
    setError(null);

    const id = ++reqIdRef.current;
    const handle = (event: MessageEvent<GeneratorWorkerResponse>) => {
      const data = event.data;
      if (!data || data.id !== id) return;
      if (data.type === 'done') {
        workerRef.current?.removeEventListener('message', handle as EventListener);
        setReport(data.result);
        setRunMode('worker');
        setState('done');
      } else if (data.type === 'error') {
        workerRef.current?.removeEventListener('message', handle as EventListener);
        setError(data.message);
        setState('error');
      }
    };

    try {
      const worker = new Worker(
        new URL('../../workers/generator.worker.ts', import.meta.url),
        { type: 'module' },
      );
      workerRef.current = worker;
      worker.addEventListener('message', handle as EventListener);
      worker.addEventListener('error', () => {
        workerRef.current?.removeEventListener('message', handle as EventListener);
        runInline();
      });
      const request: GeneratorWorkerRequest = {
        id,
        seasons: leagueSeasons,
        league,
      };
      worker.postMessage(request);
    } catch {
      runInline();
    }
  }, [leagueSeasons, league, runInline]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const handleExport = useCallback(() => {
    if (!report) return;
    const blob = new Blob([generatorReportToJson(report)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = generatorReportFileName(report);
    a.click();
    URL.revokeObjectURL(url);
  }, [report]);

  const hasSeasons = leagueSeasons.length > 0;
  const testsCompleted = report ? completedTestCount(report) : 0;

  return (
    <Collapsible
      title="Generátor-szerkezeti tesztszvit (5 hipotézis)"
      subtitle={
        hasSeasons
          ? `${leagueSeasons.length} szezon · ${LEAGUE_LABEL[league]} · ${leagueSeasons.reduce((a, s) => a + s.matches.length, 0)} meccs`
          : 'Nincs betöltött szezen ehhez a ligához'
      }
    >
      <div className="flex flex-col gap-3.5 p-4 sm:p-5">
        {/* --- Intro ----------------------------------------------------------- */}
        <p className="text-ui-xs text-muted-foreground">
          Öt, csak olvasható statisztikai teszt vizsgálja, hogy a megfigyelt adat
          kompatibilis-e a generátor feltételezett szerkezetével. A teszt soha nem
          bizonyít — minden válasz COMPATIBLE / INCOMPATIBLE / INCONCLUSIVE. A MODEL
          IMPLICATIONS blokk javaslat; a csomag semmilyen beállítást nem módosít.
        </p>

        {/* --- Run controls ---------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={runViaWorker}
            disabled={!hasSeasons || state === 'running'}
            className="inline-flex items-center gap-1.5 rounded-md bg-signal px-3 py-1.5 text-ui-sm font-medium text-signal-foreground transition-colors hover:bg-signal/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === 'running' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Szvit futtatása ({LEAGUE_LABEL[league]})
          </button>

          {report && state === 'done' && (
            <>
              <button
                onClick={handleExport}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-ui-sm font-medium text-foreground transition-colors hover:bg-white/[0.04]"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                JSON export
              </button>
              <span className="text-ui-xs text-muted-foreground">
                {testsCompleted}/5 teszt · {runMode === 'worker' ? 'worker' : 'inline'}
              </span>
            </>
          )}
        </div>

        {/* --- Error ----------------------------------------------------------- */}
        {state === 'error' && error && (
          <div className="flex items-start gap-2 rounded-lg border border-negative/30 bg-negative-soft/30 px-3 py-2.5 text-ui-xs text-negative">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {/* --- Running placeholder --------------------------------------------- */}
        {state === 'running' && !report && (
          <div className="flex items-center gap-2 py-4 text-ui-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            A tesztszvit fut — a walk-forward illesztések és bootstrap intervallumok
            számítása folyamatban…
          </div>
        )}

        {/* --- Results --------------------------------------------------------- */}
        {report && (state === 'done' || state === 'running') && (
          <div className="flex flex-col gap-3">
            {/* Baseline */}
            {report.baseline && (
              <TestResultCard title="Alapvonal (base-rate vs rating)" result={report.baseline.result} />
            )}

            {/* Independence / Form */}
            {report.independence && (
              <TestResultCard title="1. Függetlenség / Form (rating + form vs rating)" result={report.independence.result}>
                {report.independence.series && (
                  <div className="mt-2 text-ui-xs text-muted-foreground">
                    <span className="text-foreground/70">Szekvencia-diagnosztika:</span>{' '}
                    ACF lag1={report.independence.series.meanAutocorrelation[0]?.toFixed(3) ?? '—'},
                    Ljung–Box elutasítás={
                      (report.independence.series.ljungBoxRejectShare * 100).toFixed(0)
                    }%,
                    runs elutasítás={
                      (report.independence.series.runsRejectShare * 100).toFixed(0)
                    }%
                  </div>
                )}
              </TestResultCard>
            )}

            {/* Stationarity */}
            {report.stationarity && (
              <TestResultCard title="2. Sztacionaritás (frozen vs rolling refit)" result={report.stationarity.result}>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-ui-xs text-muted-foreground">
                  <span>
                    <span className="text-foreground/70">H/D/A homogenitás p:</span>{' '}
                    {formatPValue(report.stationarity.outcomeHomogeneity.p)}
                  </span>
                  <span>
                    <span className="text-foreground/70">Hazai győzelmi arány sáv:</span>{' '}
                    {(report.stationarity.homeWinRateSpread * 100).toFixed(1)}%
                  </span>
                  <span>
                    <span className="text-foreground/70">Szezonok:</span>{' '}
                    {report.stationarity.seasons.length}
                  </span>
                </div>
              </TestResultCard>
            )}

            {/* Home Advantage */}
            {report.homeAdvantage && (
              <TestResultCard title="3. Hazai előny (intercept=0 vs szabad intercept)" result={report.homeAdvantage.result}>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-ui-xs text-muted-foreground">
                  <span>
                    <span className="text-foreground/70">Hazai győzelem:</span>{' '}
                    {(report.homeAdvantage.homeWinRate * 100).toFixed(1)}%
                  </span>
                  <span>
                    <span className="text-foreground/70">Vendég győzelem:</span>{' '}
                    {(report.homeAdvantage.awayWinRate * 100).toFixed(1)}%
                  </span>
                  <span>
                    <span className="text-foreground/70">Átlagos gólkülönbség:</span>{' '}
                    {formatEffect(report.homeAdvantage.meanGoalDiff)}
                  </span>
                </div>
              </TestResultCard>
            )}

            {/* H2H */}
            {report.h2h && (
              <TestResultCard title="4. Head-to-Head (rating+form vs rating+form+H2H)" result={report.h2h.result}>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-ui-xs text-muted-foreground">
                  <span>
                    <span className="text-foreground/70">Párok előtörténettel:</span>{' '}
                    {report.h2h.pairsWithHistory}
                  </span>
                  <span>
                    <span className="text-foreground/70">Átl. korábbi találkozó:</span>{' '}
                    {report.h2h.meanPriorMeetings.toFixed(1)}
                  </span>
                </div>
              </TestResultCard>
            )}

            {/* Goal Distribution */}
            {report.goalDistribution && (
              <TestResultCard title="5. Góleloszlás (Poisson illeszkedés)" result={report.goalDistribution.result}>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-ui-xs text-muted-foreground">
                  <span>
                    <span className="text-foreground/70">Átlag gól:</span>{' '}
                    {report.goalDistribution.meanGoals.toFixed(2)}
                  </span>
                  <span>
                    <span className="text-foreground/70">Diszperzió:</span>{' '}
                    {formatEffect(report.goalDistribution.dispersion)}
                  </span>
                  <span>
                    <span className="text-foreground/70">χ² fit p:</span>{' '}
                    {formatPValue(report.goalDistribution.chiSquare.p)}
                  </span>
                  <span>
                    <span className="text-foreground/70">BTTS függetlenség p:</span>{' '}
                    {formatPValue(report.goalDistribution.bttsIndependence.p)}
                  </span>
                </div>
              </TestResultCard>
            )}

            {/* --- Multiplicity ledger ----------------------------------------- */}
            {report.multiplicity.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-surface-1/50 p-3.5">
                <h4 className="text-ui-sm font-medium text-foreground">
                  Benjamini–Hochberg többszörös tesztelés (FDR = {report.fdr})
                </h4>
                <TableScroll className="mt-2 max-h-[200px]">
                  <Table minWidth={420} className="tabular-nums">
                    <thead>
                      <tr>
                        <Th>Teszt</Th>
                        <Th align="center">Nyers p</Th>
                        <Th align="center">Korrigált p</Th>
                        <Th align="center">Elutasítva</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.multiplicity.map((row) => (
                        <Tr key={row.test}>
                          <Td>{row.test}</Td>
                          <Td align="center">{formatPValue(row.rawPValue)}</Td>
                          <Td align="center">{formatPValue(row.adjustedPValue)}</Td>
                          <Td align="center">
                            {row.rejected ? (
                              <Badge className="bg-negative-soft text-negative">igen</Badge>
                            ) : (
                              <Badge className="bg-white/[0.06] text-muted-foreground">nem</Badge>
                            )}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableScroll>
              </div>
            )}

            {/* --- Model implications ------------------------------------------ */}
            {report.implications.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-surface-1/50 p-3.5">
                <h4 className="text-ui-sm font-medium text-foreground">
                  MODEL IMPLICATIONS (javaslatok — nincs automatikus módosítás)
                </h4>
                <TableScroll className="mt-2 max-h-[280px]">
                  <Table minWidth={620} className="tabular-nums">
                    <thead>
                      <tr>
                        <Th>Komponens</Th>
                        <Th>Jelenlegi beállítás</Th>
                        <Th align="center">Eredmény</Th>
                        <Th align="center">Javaslat</Th>
                        <Th align="center">OOS ΔBrier</Th>
                        <Th align="center">OOS ΔLogLoss</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.implications.map((imp: ModelImplication, i) => (
                        <Tr key={`${imp.component}-${i}`}>
                          <Td>{imp.component}</Td>
                          <Td className="text-muted-foreground">{imp.currentSetting}</Td>
                          <Td align="center">
                            <Badge className={conclusionTone[imp.suiteResult]}>
                              {conclusionLabel[imp.suiteResult]}
                            </Badge>
                          </Td>
                          <Td align="center">
                            <Badge className={implicationTone[imp.suggestedState]}>
                              {imp.suggestedState}
                            </Badge>
                          </Td>
                          <Td align="center">
                            {imp.oosDeltaBrier !== undefined ? imp.oosDeltaBrier.toFixed(4) : '—'}
                          </Td>
                          <Td align="center">
                            {imp.oosDeltaLogLoss !== undefined ? imp.oosDeltaLogLoss.toFixed(4) : '—'}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableScroll>
                <p className="mt-2 text-ui-xs text-muted-foreground">
                  automaticConfigurationChange = false minden soron — a csomag jelent, nem állít be.
                </p>
              </div>
            )}

            {/* --- Caveats ------------------------------------------------------- */}
            {report.caveats.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-surface-1/30 p-3.5">
                <h4 className="text-ui-sm font-medium text-foreground">Korlátok</h4>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {report.caveats.map((caveat, i) => (
                    <li key={i} className="text-ui-xs text-muted-foreground">
                      — {caveat}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* --- Idle / no data -------------------------------------------------- */}
        {state === 'idle' && !report && hasSeasons && (
          <div className="py-3 text-center text-ui-xs text-muted-foreground">
            A szvit futtatásához kattints a „Szvit futtatása” gombra.
          </div>
        )}
        {!hasSeasons && (
          <div className="py-3 text-center text-ui-xs text-muted-foreground">
            Nincs betöltött szezen ehhez a ligához. Tölts be adatot a Data Studio lapon.
          </div>
        )}
      </div>
    </Collapsible>
  );
}
