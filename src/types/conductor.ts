import type { League } from './winmix';

export type LeagueHealthStatus = 'GREEN' | 'YELLOW' | 'RED';

export interface LeagueHealthDirective {
  league: League;
  status: LeagueHealthStatus;
  /** Signed BTTS drift in percentage points (predicted − observed). */
  bttsDriftPct: number;
  /** When true, the AI recommends suppressing the core-1 BTTS slot for this league. */
  suppressCore1: boolean;
  /** Optional human-readable warning shown in the banner. */
  warningNotice: string | null;
}

export interface StrategyDirective {
  /** AI recommends activating veto mode. */
  vetoModeActive: boolean;
  /** Allow volatile secondary markets on the slip. */
  allowVolatileSecondary: boolean;
  /** Market codes the AI recommends focusing on (e.g. ['BTTS', 'O2.5']). */
  recommendedMarkets: string[];
  /** Short tactical summary in Hungarian. */
  tacticalSummary: string;
}

export interface WeightTuningProposal {
  league: League;
  teamKey: string;
  /** Which metric/weight to adjust, e.g. 'attack' or 'defense'. */
  metric: string;
  currentValue: number;
  proposedValue: number;
  reason: string;
}

export interface ConductorDirectives {
  timestamp: string;
  leagues: LeagueHealthDirective[];
  strategy: StrategyDirective;
  proposals: WeightTuningProposal[];
}

/** Sentinel: safe defaults used when the AI is unavailable or hasn't responded. */
export function defaultDirectives(): ConductorDirectives {
  return {
    timestamp: new Date(0).toISOString(),
    leagues: [
      { league: 'angol', status: 'GREEN', bttsDriftPct: 0, suppressCore1: false, warningNotice: null },
      { league: 'spanyol', status: 'GREEN', bttsDriftPct: 0, suppressCore1: false, warningNotice: null },
    ],
    strategy: {
      vetoModeActive: false,
      allowVolatileSecondary: true,
      recommendedMarkets: [],
      tacticalSummary: 'AI felügyelet inaktív — a rendszer alapértelmezett matematikai móddal működik.',
    },
    proposals: [],
  };
}
