import React, {
  lazy,
  Suspense,
  useCallback,
  useRef,
  useState,
} from 'react';
import { Toaster, toast } from 'sonner';

import { fetchRemoteSeasonFiles } from './utils/remoteSeasons';

import { CloudTierProvider } from './contexts/CloudTierContext';
import { DialogProvider } from './contexts/DialogContext';
import { WinmixProvider, useWinmix } from './contexts/WinmixContext';

import { ImportPreviewModal } from './components/winmix/ImportPreviewModal';
import { NavRail } from './components/winmix/NavRail';
import { StatusBar } from './components/winmix/StatusBar';
import { TopBar } from './components/winmix/TopBar';

import { useScreenInit } from './useScreenInit.js';

import type { ViewKey } from './types/winmix';

/* ==========================================================================
 * Lazy page imports
 * --------------------------------------------------------------------------
 * Pages are loaded only when the corresponding view is opened.
 * This keeps the initial application bundle smaller and avoids loading
 * heavyweight analytics / pipeline dependencies unnecessarily.
 * ========================================================================== */

const DataStudio = lazy(() =>
  import('./pages/DataStudio').then((m) => ({ default: m.DataStudio }))
);
const FixturePredictor = lazy(() =>
  import('./pages/FixturePredictor').then((m) => ({ default: m.FixturePredictor }))
);
const HeadToHead = lazy(() =>
  import('./pages/HeadToHead').then((m) => ({ default: m.HeadToHead }))
);
const LeagueAnalyzer = lazy(() =>
  import('./pages/LeagueAnalyzer').then((m) => ({ default: m.LeagueAnalyzer }))
);
const PipelineAudit = lazy(() =>
  import('./pages/PipelineAudit').then((m) => ({ default: m.PipelineAudit }))
);
const PipelineOperationsDashboard = lazy(() =>
  import('./pages/PipelineOperationsDashboard').then((m) => ({
    default: m.PipelineOperationsDashboard,
  }))
);
const PredictionLedger = lazy(() =>
  import('./pages/PredictionLedger').then((m) => ({ default: m.PredictionLedger }))
);

/* ==========================================================================
 * View validation
 * --------------------------------------------------------------------------
 * `useScreenInit()` receives the initial screen from the URL / preview
 * environment. Never trust that value blindly at runtime.
 *
 * Example:
 *   ?mp_screen=foobar
 *
 * must safely fall back to dashboard rather than leaving the application
 * without a matching render branch.
 * ========================================================================== */

const VALID_VIEWS = new Set<ViewKey>([
  'dashboard',
  'operations',
  'pipeline',
  'league',
  'h2h',
  'predictor',
  'ledger',
]);

function isViewKey(value: unknown): value is ViewKey {
  return typeof value === 'string' && VALID_VIEWS.has(value as ViewKey);
}

function toViewKey(value: unknown): ViewKey {
  return isViewKey(value) ? value : 'dashboard';
}

/* ==========================================================================
 * Lazy-page loading fallback
 * ========================================================================== */

function PageLoadingSpinner() {
  return (
    <div
      role="status"
      aria-label="Betöltés…"
      className="flex h-64 w-full items-center justify-center text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="animate-spin text-2xl"
      >
        ⟳
      </span>

      <span className="sr-only">
        Az oldal betöltése folyamatban…
      </span>
    </div>
  );
}

/* ==========================================================================
 * Studio Shell
 * ========================================================================== */

function StudioShell() {
  const screenInit = useScreenInit();

  /**
   * Runtime-safe initial view.
   *
   * The lazy initializer ensures `toViewKey()` only executes during the
   * initial state creation rather than on every render.
   */
  const [view, setView] = useState<ViewKey>(() =>
    toViewKey(screenInit?.view)
  );

  const {
    currentLeague,
    setLeague,
    recomputeAll,
    clearAll,
    exportJson,
    importPreview,
    beginImport,
    cancelImport,
    applyImport,
    importFiles,
    isComputing,
  } = useWinmix();

  /**
   * Visual loading state.
   *
   * State is intentionally retained because the UI needs to re-render while
   * loading is active.
   */
  const [loadingMatches, setLoadingMatches] = useState(false);

  /**
   * Synchronous mutex for the remote match loader.
   *
   * React state updates are asynchronous. A very fast second click could
   * otherwise enter handleLoadMatches() before loadingMatches becomes true.
   *
   * The ref closes that race because ref.current changes synchronously.
   */
  const loadingMatchesRef = useRef(false);

  /**
   * Remote match loader.
   *
   * Flow:
   *
   * 1. Acquire synchronous mutex.
   * 2. Show progress toast.
   * 3. Download remote season CSVs.
   * 4. Report partial failures.
   * 5. Pass files through the exact same import pipeline used elsewhere.
   * 6. Release mutex in finally, regardless of success/failure.
   */
  const handleLoadMatches = useCallback(async () => {
    if (loadingMatchesRef.current) {
      return;
    }

    loadingMatchesRef.current = true;
    setLoadingMatches(true);

    const toastId = toast.loading('Mérkőzés-CSV-k letöltése…');

    try {
      const { files, failures } = await fetchRemoteSeasonFiles(
        (done, total) => {
          toast.loading(
            `Mérkőzés-CSV-k letöltése… ${done} / ${total}`,
            {
              id: toastId,
            }
          );
        }
      );

      toast.dismiss(toastId);

      if (files.length === 0) {
        toast.error(
          'Egyetlen mérkőzés-CSV sem töltődött le — ellenőrizd a hálózati kapcsolatot.'
        );

        return;
      }

      if (failures.length > 0) {
        const visibleFailures = failures.slice(0, 3).join(', ');
        const suffix = failures.length > 3 ? ' …' : '';

        toast.warning(
          `${failures.length} fájl kimaradt: ${visibleFailures}${suffix}`
        );
      }

      /**
       * Important:
       *
       * Remote files deliberately enter the existing import path.
       * This preserves parsing, league detection and pipeline recalculation
       * behavior instead of creating a second import implementation.
       */
      await importFiles(files, 'auto');
    } catch (error) {
      toast.dismiss(toastId);

      const message =
        error instanceof Error
          ? error.message
          : 'ismeretlen hiba';

      toast.error(
        `A mérkőzések betöltése nem sikerült: ${message}`
      );
    } finally {
      loadingMatchesRef.current = false;
      setLoadingMatches(false);
    }
  }, [importFiles]);

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background md:flex-row">
      {/* ====================================================================
       * Accessibility: keyboard skip navigation
       * ==================================================================== */}

      <a
        href="#main-content"
        className="
          sr-only
          focus:not-sr-only
          focus:absolute
          focus:left-4
          focus:top-4
          focus:z-[100]
          focus:rounded-lg
          focus:bg-signal
          focus:px-4
          focus:py-2
          focus:text-sm
          focus:font-medium
          focus:text-signal-foreground
          focus:shadow-lg
          focus:outline-none
          focus:ring-2
          focus:ring-signal
          focus:ring-offset-2
          focus:ring-offset-background
        "
      >
        Ugrás a fő tartalomhoz
      </a>

      {/* ====================================================================
       * Navigation
       * ==================================================================== */}

      <NavRail
        view={view}
        onChange={setView}
        onExport={() => void exportJson()}
        onImport={(file) => void beginImport(file)}
      />

      {/* ====================================================================
       * Application content area
       * ==================================================================== */}

      <div className="order-1 flex min-w-0 flex-1 flex-col overflow-hidden md:order-2">
        <TopBar
          league={currentLeague}
          onLeagueChange={setLeague}
          onRunPipeline={() =>
            void recomputeAll(
              'Pipeline v2 walk-forward predikciók + prequenciális kalibráció lefutott!'
            )
          }
          onLoadMatches={() => void handleLoadMatches()}
          onClearAll={() => void clearAll()}
          busy={isComputing}
          loadingMatches={loadingMatches}
        />

        <StatusBar />

        {/* ==================================================================
         * Main content
         * ================================================================== */}

        <main
          id="main-content"
          tabIndex={-1}
          className="
            flex-1
            overflow-y-auto
            overflow-x-hidden
            focus:outline-none
          "
        >
          <div
            className="
              mx-auto
              w-full
              max-w-[1600px]
              px-3
              py-4
              sm:px-4
              sm:py-5
              md:px-6
              md:py-6
            "
          >
            <Suspense fallback={<PageLoadingSpinner />}>
              {view === 'dashboard' && <DataStudio />}

              {view === 'operations' && (
                <PipelineOperationsDashboard />
              )}

              {view === 'pipeline' && <PipelineAudit />}

              {view === 'league' && <LeagueAnalyzer />}

              {view === 'h2h' && <HeadToHead />}

              {view === 'predictor' && <FixturePredictor />}

              {view === 'ledger' && <PredictionLedger />}
            </Suspense>
          </div>
        </main>
      </div>

      {/* ====================================================================
       * Global screen-reader status announcements
       * ==================================================================== */}

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {isComputing
          ? 'Pipeline számítás folyamatban…'
          : loadingMatches
            ? 'Mérkőzés-adatok letöltése folyamatban…'
            : ''}
      </div>

      {/* ====================================================================
       * Import preview modal
       * ==================================================================== */}

      {importPreview ? (
        <ImportPreviewModal
          fileName={importPreview.fileName}
          current={importPreview.current}
          incoming={importPreview.incoming}
          warnings={importPreview.warnings}
          busy={isComputing}
          onCancel={cancelImport}
          onApply={(mode) => void applyImport(mode)}
        />
      ) : null}
    </div>
  );
}

/* ==========================================================================
 * Root application providers
 * ========================================================================== */

export function App() {
  return (
    <DialogProvider>
      <WinmixProvider>
        <CloudTierProvider>
          <StudioShell />
        </CloudTierProvider>
      </WinmixProvider>

      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: '0.75rem',
            boxShadow: 'var(--shadow-panel-lg)',
            color: 'var(--foreground)',
            fontSize: '12px',
          },
        }}
      />
    </DialogProvider>
  );
}
