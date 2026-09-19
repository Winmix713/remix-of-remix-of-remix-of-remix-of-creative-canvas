import { RefreshCw, ShieldCheck, ShieldAlert, Zap, Check } from 'lucide-react';
import type { ConductorDirectives, LeagueHealthDirective, WeightTuningProposal } from '../../types/conductor';
import type { BttsVetoMode, League } from '../../types/winmix';
import { cn } from '../../lib/utils';

interface ConductorBannerProps {
  directives: ConductorDirectives;
  loading: boolean;
  error: string | null;
  currentVetoMode: BttsVetoMode;
  onToggleVeto: () => void;
  onAcceptProposal: (proposal: WeightTuningProposal) => void;
  onRefresh: () => void;
}

const healthTone: Record<string, string> = {
  GREEN: 'bg-positive-soft text-positive border-positive/30',
  YELLOW: 'bg-warning-soft text-warning border-warning/30',
  RED: 'bg-negative-soft text-negative border-negative/30',
};

const healthLabel: Record<string, string> = {
  GREEN: 'STABIL',
  YELLOW: 'FIGYELEM',
  RED: 'KOCKÁZAT',
};

function LeagueBadge({ directive }: { directive: LeagueHealthDirective }) {
  const leagueLabel = directive.league === 'angol' ? 'Angol' : 'Spanyol';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-ui-xs font-medium tabular-nums',
        healthTone[directive.status]
      )}
    >
      <span className="font-semibold">{leagueLabel}</span>
      <span className="opacity-70">·</span>
      <span>{healthLabel[directive.status]}</span>
      <span className="opacity-60">
        drift {directive.bttsDriftPct > 0 ? '+' : ''}{directive.bttsDriftPct.toFixed(1)}pp
      </span>
    </span>
  );
}

export function ConductorBanner({
  directives,
  loading,
  error,
  currentVetoMode,
  onToggleVeto,
  onAcceptProposal,
  onRefresh,
}: ConductorBannerProps) {
  const vetoActive = currentVetoMode === 'active';
  const aiRecommendsVeto = directives.strategy.vetoModeActive;
  const vetoPending = aiRecommendsVeto && !vetoActive;

  const hasProposals = directives.proposals.length > 0;
  const isDefault = directives.timestamp === new Date(0).toISOString();

  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-surface-1 p-4 shadow-panel',
        vetoPending && 'border-warning/40'
      )}
    >
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-lg',
              isDefault ? 'bg-white/[0.06] text-muted-foreground' : 'bg-signal-soft text-signal'
            )}
          >
            <Zap className="h-4 w-4" aria-hidden={true} />
          </span>
          <span className="text-ui-sm font-semibold text-foreground">AI Conductor</span>
          {isDefault && !loading ? (
            <span className="text-ui-xs text-muted-foreground">— offline mód</span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {/* League badges */}
          <div className="flex items-center gap-1.5">
            {directives.leagues.map((l) => (
              <LeagueBadge key={l.league} directive={l} />
            ))}
          </div>

          {/* Veto toggle */}
          <button
            type="button"
            onClick={onToggleVeto}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-ui-xs font-medium transition-colors tap',
              vetoActive
                ? 'border-positive/40 bg-positive-soft text-positive'
                : vetoPending
                  ? 'border-warning/40 bg-warning-soft text-warning animate-pulse'
                  : 'border-border bg-surface-2 text-muted-foreground hover:text-foreground'
            )}
          >
            {vetoActive ? (
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden={true} />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden={true} />
            )}
            {vetoActive
              ? 'Vétó aktív'
              : vetoPending
                ? 'AI javaslat: Vétó bekapcsolása'
                : 'Vétó inaktív'}
          </button>

          {/* Refresh */}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-ui-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 tap"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden={true} />
            Frissít
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && isDefault && !loading ? (
        <p className="mt-2 text-ui-xs text-negative">
          {error}
        </p>
      ) : null}

      {/* Tactical summary */}
      {!isDefault && directives.strategy.tacticalSummary ? (
        <p className="mt-3 text-ui-sm leading-relaxed text-muted-foreground">
          {directives.strategy.tacticalSummary}
        </p>
      ) : null}

      {/* Warning notices */}
      {directives.leagues.filter((l) => l.warningNotice).length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {directives.leagues
            .filter((l) => l.warningNotice)
            .map((l) => (
              <p key={l.league} className="text-ui-xs text-warning">
                {l.league === 'angol' ? 'Angol' : 'Spanyol'}: {l.warningNotice}
              </p>
            ))}
        </div>
      ) : null}

      {/* Weight tuning proposals */}
      {hasProposals ? (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-2 text-ui-xs font-medium text-foreground">
            Csapatsúly-korrekciós javaslatok
          </p>
          <div className="flex flex-col gap-2">
            {directives.proposals.map((p, i) => (
              <div
                key={`${p.league}-${p.teamKey}-${p.metric}-${i}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-ui-xs font-medium text-foreground">
                    {p.league === 'angol' ? 'Angol' : 'Spanyol'} · {p.teamKey}
                  </span>
                  <span className="text-ui-xs text-muted-foreground">
                    {' '}· {p.metric}: {p.currentValue.toFixed(1)} → {p.proposedValue.toFixed(1)}
                  </span>
                  <p className="text-ui-xs text-muted-foreground">{p.reason}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onAcceptProposal(p)}
                  className="inline-flex items-center gap-1 rounded-md border border-signal/40 bg-signal-soft px-2 py-1 text-ui-xs font-medium text-signal transition-colors hover:bg-signal/10 tap"
                >
                  <Check className="h-3 w-3" aria-hidden={true} />
                  Jóváhagy
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
