# Generator Structure Suite — PHASE 1 (alap + Independence)

## Ellenőrzött kiindulás

- `src/utils/generator/` még nem létezik.
- `src/utils/backtest/metrics.ts` **nem létezik** — a specifikáció erre hivatkozik. Brier/LogLoss/ECE ma szétszórtan él (`src/utils/stats.ts`: ECE, kalibráció, előjelteszt; `src/utils/bootstrap.ts`: seedelt mulberry32, bootstrap CI, Wilson).
- `BOOTSTRAP_SEED = 20260825`, `BOOTSTRAP_ITERATIONS = 1000` a `src/utils/constants.ts`-ben — ezeket használjuk.
- A `PipelineAudit` oldalnak jelenleg **nincs** fül-szerkezete; a worker-minta a `pipelineRunner.ts` + `workers/pipeline.worker.ts` párosból másolható (worker, inline fallback-kel).
- A tesztek ma `src/__tests__/` alatt vannak (4 fájl, 30 teszt), Vitest + jsdom.

## Ebben a fázisban szállítandó

### 1. Mérőszám-alap
`src/utils/backtest/metrics.ts` létrehozása (mert nincs): `brier`, `logLoss`, `ece` a `Probs`/`Outcome` típusokra. Az ECE a meglévő `computeECEGeneric`-re épül, nem duplikálja azt. Ez lesz az egyetlen metrika-forrás a suite számára.

### 2. `src/utils/generator/types.ts`
`Conclusion` (`COMPATIBLE` | `INCOMPATIBLE` | `INCONCLUSIVE`), `Effect` (estimate, ci95Low, ci95High), `TestResult` (conclusion, effect, rawPValue, adjustedPValue, oosDeltaBrier, oosDeltaLogLoss, sampleSize, leakageSafe), `LeakageAudit` (informationCutoff, trainingRange, testRange), `DatasetInfo` (league, seasonCount, matchCount, seed). A `KEEP`/`REMOVE` csak a `ModelImplication` típusban jelenhet meg.

### 3. `src/utils/generator/ratings.ts`
Külön, elemzési célú, determinisztikus rating — a WinMix rating-motort nem érinti. Szigorúan walk-forward: a `t` indexű mérkőzés ratingje csak a `0..t-1` mérkőzésekből épül. Kimenet: `ratingAt(index)` + 1X2 valószínűség rating-különbségből (logisztikus link, fix paraméterekkel).

### 4. `src/utils/generator/permutation.ts`
Seedelt keret: `permutationTest`, `bootstrapCI` — mind a `mulberry32(BOOTSTRAP_SEED)`-re épül a `bootstrap.ts`-ből. Nincs `Math.random`, nincs óra.

### 5. `src/utils/generator/independence.ts`
- Sorozat-diagnosztika csapatonként: autokorreláció lag 1–5, Ljung–Box, Wald–Wolfowitz runs teszt (a hiányzó statisztikák a `stats.ts`-be kerülnek, nem duplikálva).
- Kötelező OOS összehasonlítás: **Model A** rating-only vs **Model B** rating + előző 5 mérkőzés formája, szigorú walk-forward módon.
- Kimenet: ΔBrier, ΔLogLoss, 95% CI, effect size, raw p, `leakageSafe: true`, `conclusion`.
- Liga-szinten külön fut (angol / spanyol), nincs összevont futtatás.

### 6. Szintetikus validáció (release gate)
`src/utils/generator/__tests__/` alatt:
- `permutation.test.ts` — determinizmus, ismételt futás azonos kimenet.
- `ratings.test.ts` — nincs jövőbeli információ (leakage-próba: a jövő eredményének megváltoztatása nem változtathatja a korábbi predikciót).
- `independence.test.ts` — ismert paraméterű generátorok: (A) nincs forma, (B) van forma. Elvárás: A → nincs kimutatható OOS többletjel, B → kimutatható. Plusz determinisztikus ismétlés-teszt.

Ha a suite a kontrollált szintetikus generátorokat nem különbözteti meg, a valós adaton kapott eredmény nem használható.

## Amit ebben a fázisban nem csinálunk

Stationarity, Goal Distribution, Home Advantage, H2H, minimal baseline, BH-korrekció, report, JSON export és a Pipeline Audit új füle a PHASE 2-ben jön, az első review gate után.

## Kötelező korlátok

- A Prediction Engine, a rating, a gate-ek, a rangsor, a kalibráció és a feature flagek **nem** módosulnak.
- A `pipeline` mező nem használható bemenetként.
- Nincs automatikus konfigurációmódosítás; λ = 0.88 érintetlen.
- Minden véletlen eljárás seedelt, a seed a kimenetben látszik.
- Sehol nem jelenik meg „bizonyított” / „proven” megfogalmazás.

## Review gate (PHASE 1 kész, ha)

Típusarchitektúra rendben · rating baseline walk-forward · permutáció determinisztikus · Independence fut · szintetikus tesztek zöldek · nincs leakage · OOS Brier/LogLoss összehasonlítás működik · `bunx tsgo --noEmit` és a teljes Vitest futás (meglévő 30 teszt + újak) zöld.
