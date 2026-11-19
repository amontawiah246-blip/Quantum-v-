MULTI-AGENT CANDIDATE BROADCAST (see docs/CANDIDATE_BROADCAST.md). The existing market agents now broadcast every live setup, with the agent's own screenshot and
OHLC, to the three strategy engines + the AI/hybrid verification at the same moment, as one frozen, versioned, hashed candidate. Repaired, not replaced:
- New: src/candidateTypes.ts, candidateHub.ts, candidateEngines.ts, verificationCoordinator.ts, candidatePipeline.ts, candidateLook.ts, concurrency.ts, candidateServer.ts, src/candidateBroadcast.test.ts
- Changed (additive): src/sweepWatcherCore.ts (one independent loop per agent, bounded + timed-out requests, publishes candidates, live chart updates), src/sweepWatcher.ts (hub + rasterizer, M5 default),
  signalServer.ts (optional `image`: the AI uses the candidate's screenshot instead of drawing a second one), autoServer.ts + src/autoLook.ts (read the candidate's decision; cancel on invalidation / stale / duplicate), server.ts (one line), package.json (test:candidates), .env.example
- AGENT-DRIVEN AUTOTRADE (docs/AGENT_AUTOTRADE.md): on Deriv, AI Trading no longer scans. It subscribes to the agents' approved setups (src/agentSource.ts, autotradeFeed.ts, agentMode.ts; autopilot.ts agent mode;
  autoServer.ts), shows live counters + activity feed (AutopilotUI.tsx AgentDashboard, ProMode.tsx). Other brokers keep the original scan loop.
- Tests: npm run test:candidates   (all tests: npx tsx --test src/*.test.ts)

HYBRID x AUTOTRADING x GEMINI SCREENSHOT VERIFICATION CONNECTED (see docs/HYBRID_AUTOTRADING.md). Additive: src/hybridGate.ts, hybridEvidence.ts, aiContract.ts, executionGate.ts, autoLook.ts, tradeLog.ts, hybridRoutes.ts (+ tests). Changed: signalServer.ts, autoServer.ts, server.ts, src/autopilot.ts (optional preflight hook), src/aiVerification.ts (optional evidence block, ledger.has/release), src/hybridEngine.ts (bySide), src/SignalsPage.tsx (hybrid line + screenshot). Fixed: scanning no longer uses up the candle. Defaults: HYBRID_AUTOTRADE=veto. Tests: npm run test:hybridauto

HYBRID AI LAYER ADDED (see docs/HYBRID_AI.md). Additive: src/hybrid*.ts, src/equalLevelSweeps.ts, ml/, models/, docs/hybrid/, a `hybrid` field on /api/engines. Install with: npm install --legacy-peer-deps
ENGINES 7-12 (market context, momentum exhaustion, repeated sweep intelligence) ADDED. Nothing existing was removed.
- New: src/sequenceClassifier.ts, sequenceStats.ts, structureEngine.ts, sweepIntelligence.ts, reversalConfirmation.ts, continuationConfirmation.ts,
  exhaustionEngine.ts, quantumPipeline.ts, executionConfig.ts, intelBacktest.ts + tests (quantumEngines, intelBacktest, intelEvaluator).
- Changed (additive): src/engineBacktest.ts (execution delay, fine data, payout table, execution record), src/engineBacktestCli.ts (--intel, --fine, --delay,
  --payout-table, --resample; default expiry now follows the live policy: 5-minute chart = 300 s), src/engineEvaluator.ts (extra `intelligence` field, votes unchanged), package.json (scripts).
- Docs: docs/ENGINES_7_12.md.  Tests: npm run test:quantum   Backtest: npm run backtest:intel -- --csv EURUSD_5m.csv ...

THREE SETUP ENGINES + CORRECTED SCREENSHOTS (Menu tab, agent cards)
- src/sweepEngines.ts   the three engines. 1) Wick sweep: your original rule, ported 1:1 and checked against the Python engine on
                        ~1,100 signals. 2) Sweep continuation: sweeper + TWO more candles closing the same colour, then trade the
                        NEXT candle open in the same direction. 3) Momentum: three strong-bodied candles in a row, no sweep needed,
                        trade the next candle open (needs big bodies; there is no separate "fake" rule).
- src/sweepWatcher.ts / sweepWatcherCore.ts   watch every agent on CLOSED candles only (broker clock). A screenshot is posted ONLY when an
                        engine really finds a setup. The old filler "snapshot" charts (RSI/Flow text, "Watching closed market candles") are gone.
- src/sweepChart.ts     each engine draws what it found. Continuation/momentum show the arrow in the empty slot where the next candle opens.
- src/engineEvaluator.ts + server.ts   the trading signal path now uses the same corrected sweep rule plus the two new engines,
                        and /api/engines evaluates closed candles only.
- Menu: filter by engine; each alert shows its engine and "Trade opens on the next candle".
- Tests:  npx tsx --test src/*.test.ts

NEW: WICK SWEEP ALERTS (Menu tab)
- The 16 agents' markets are watched by the wick sweep engine on CLOSED candles. The moment a setup forms, a chart screenshot
  (same look as your Valid Buy / Valid Sell Setup images) appears in Menu, with a badge on the Menu button and a toast.
- TAKE = sweep + context check passed. SKIP = sweep seen but the context check said no (shown so you can judge the filter too).
- Each of the 16 agent cards in Signal Package also shows its wick sweep verdict (tap it for the screenshot).
- Under each screenshot: "Engine is right" / "Engine is wrong" to keep a tally while you verify.
- bridge/sweep_watch.py (watcher), bridge/sweep_chart.py (screenshot), bridge/engines/wick_sweep_engine.py (your engine, unchanged),
  src/SweepAlerts.tsx (Menu screen), /api/sweep proxy in server.ts. Starts by itself with the bridge; set SWEEP_WATCH=0 to turn that off.
- Test:  cd bridge && python3 -m unittest test_sweep_watch

Upload this project AS IS. Tell Gemini / AI Studio: replace the project files with the ones in this zip exactly; do not redesign, rewrite or improve any file.

NEW IN THIS VERSION
- bridge/engines/  your three engines + combine.py (sweep = boss, 2+ indicator strategies confirm, candle pattern counts only if indicators agree)
- signalServer.ts  AI check (Gemini approves or vetoes each setup) and /api/signal. Needs GEMINI_API_KEY in the server environment.
- autoServer.ts    AI Trading runs on the server (keeps going with the phone locked). Works on Pocket, Quotex, IQ Option, Deriv (Rise/Fall).
- Demo / Real switch on Home and in the AI Trading window.
- The chart is untouched: everything runs in the background.

Tests:  npx tsx --test src/*.test.ts      and      cd bridge && python3 -m unittest test_engines

--- Live-data test, PAT fix, agent Auto scan ---
* AI Trading on Deriv now refuses to start unless the Deriv account (PAT) is connected, and stops at the first "account not connected" refusal.
  Orders cannot be placed without your PAT: enter it on the API screen.
* Signals page "Auto" on Deriv reads the market agents' setups and screenshots (no second scan) when the agents are running.
* New test: src/liveReplay.test.ts, using fixtures/r75_m5_live_slice.csv (npm: npx tsx --test src/*.test.ts, 291 tests).

--- LSCC strategy ---
* New independent strategy: Liquidity Sweep Confirmation Candle (docs/LSCC.md). Agents register a sweep as LSCC WAITING, the next candle confirms or invalidates it,
  a confirmed setup goes to the 3 engines + Gemini with the same screenshot, AutoTrade trades the candle after the confirmation (45 s limit, 300 s expiry).
* Tests: src/lscc.test.ts (25). Full suite: npx tsx --test src/*.test.ts
