import type { League, Season, CalibrationMap, Slip, WeightMap } from '../types/winmix';
import { computeMarketFeedback, marketFeedbackRows, type MarketFeedback } from './ledger';

export interface LeagueBttsTrend {
  league: League;
  sampleSize: number;
  observedBttsRate: number;
  avgPredictedBtts: number;
}

export interface RoundSummary {
  totalMatches: number;
  bttsAbove50: number;
  blowoutRiskCount: number;
}

export interface WeightOutlier {
  league: League;
  teamKey: string;
  weight: number;
}

export interface LedgerSummary {
  totalSlips: number;
  settledSlips: number;
  wonSlips: number;
  marketFeedback: MarketFeedback;
}

export interface ConductorPayload {
  seasonCount: number;
  leagues: LeagueBttsTrend[];
  round: RoundSummary;
  weightOutliers: WeightOutlier[];
  ledger: LedgerSummary;
}

const WEIGHT_OUTLIER_THRESHOLD = 7.0;
const WEIGHT_OUTLIER_LOW = 3.0;

function computeLeagueBttsTrend(seasons: Season[], league: League): LeagueBttsTrend {
  let bttsCount = 0;
  let total = 0;
  let sumPredicted = 0;
  let predictedCount = 0;

  for (const season of seasons) {
    if (season.league !== league) continue;
    for (const match of season.matches) {
      total++;
      if (match.btts) bttsCount++;
      const p = match.pipeline?.secondary?.btts;
      if (p !== undefined && p > 0) {
        sumPredicted += p;
        predictedCount++;
      }
    }
  }

  return {
    league,
    sampleSize: total,
    observedBttsRate: total > 0 ? bttsCount / total : 0,
    avgPredictedBtts: predictedCount > 0 ? sumPredicted / predictedCount : 0,
  };
}

function computeRoundSummary(seasons: Season[]): RoundSummary {
  let total = 0;
  let bttsAbove50 = 0;
  let blowout = 0;

  for (const season of seasons) {
    for (const match of season.matches) {
      total++;
      const bttsP = match.pipeline?.secondary?.btts;
      if (bttsP !== undefined && bttsP >= 0.5) bttsAbove50++;
      const blowoutP = match.pipeline?.secondary?.cleanSheetBlowout;
      if (blowoutP !== undefined && blowoutP >= 0.35) blowout++;
    }
  }

  return { totalMatches: total, bttsAbove50, blowoutRiskCount: blowout };
}

function computeWeightOutliers(teamWeights: WeightMap): WeightOutlier[] {
  const outliers: WeightOutlier[] = [];
  for (const league of Object.keys(teamWeights) as League[]) {
    const weights = teamWeights[league];
    if (!weights) continue;
    for (const [teamKey, weight] of Object.entries(weights)) {
      if (weight >= WEIGHT_OUTLIER_THRESHOLD || weight <= WEIGHT_OUTLIER_LOW) {
        outliers.push({ league, teamKey, weight });
      }
    }
  }
  return outliers.slice(0, 10);
}

function computeLedgerSummary(slips: Slip[]): LedgerSummary {
  const settled = slips.filter((s) => {
    const grades = s.lines.map((l) => l.grade);
    return grades.length > 0 && grades.every((g) => g === 'won' || g === 'lost');
  });
  const won = settled.filter((s) => s.lines.every((l) => l.grade === 'won')).length;
  return {
    totalSlips: slips.length,
    settledSlips: settled.length,
    wonSlips: won,
    marketFeedback: computeMarketFeedback(slips),
  };
}

export function buildConductorContext(
  seasons: Season[],
  _calibration: CalibrationMap,
  slips: Slip[],
  teamWeights: WeightMap
): ConductorPayload {
  const leagues: LeagueBttsTrend[] = [
    computeLeagueBttsTrend(seasons, 'angol'),
    computeLeagueBttsTrend(seasons, 'spanyol'),
  ];

  return {
    seasonCount: seasons.length,
    leagues,
    round: computeRoundSummary(seasons),
    weightOutliers: computeWeightOutliers(teamWeights),
    ledger: computeLedgerSummary(slips),
  };
}

/** Serialise the payload into a compact prompt-friendly string for the Gemini model. */
export function payloadToPromptText(payload: ConductorPayload): string {
  const fbRows = marketFeedbackRows(payload.ledger.marketFeedback);
  const fbText = fbRows
    .map((r) => `${r.label}: előrejelzett ${(r.predicted * 100).toFixed(0)}%, tényleges ${(r.observed * 100).toFixed(0)}%, n=${r.n}`)
    .join('; ');

  const leagueText = payload.leagues
    .map((l) => `${l.league}: n=${l.sampleSize}, BTTS tényleges=${(l.observedBttsRate * 100).toFixed(0)}%, átlag predikció=${(l.avgPredictedBtts * 100).toFixed(0)}%`)
    .join('; ');

  const outlierText = payload.weightOutliers
    .map((o) => `${o.league}/${o.teamKey}: ${o.weight.toFixed(1)}`)
    .join('; ');

  return [
    `Szezonok: ${payload.seasonCount}`,
    `Ligák: ${leagueText}`,
    `Forduló: ${payload.round.totalMatches} mérkőzés, ${payload.round.bttsAbove50} BTTS≥50%, ${payload.round.blowoutRiskCount} blowout kockázat`,
    `Szelvények: ${payload.ledger.totalSlips} összes, ${payload.ledger.settledSlips} lezárt, ${payload.ledger.wonSlips} nyert`,
    `Piaci visszajelzés: ${fbText}`,
    `Kiugró csapatsúlyok: ${outlierText || 'nincs'}`,
  ].join('\n');
}
