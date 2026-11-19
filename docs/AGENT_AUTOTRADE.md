# AutoTrade is driven by the market agents (no second scanner)

## Root cause

Two systems existed side by side and never met:

1. **The market agents** (`src/sweepWatcher*.ts`) watch the markets, find *Valid Buy Momentum – 3 Green Candles* / *Valid Buy Continuation – Sweep + 2 Green Candles* and draw the screenshot. Their only output was the Menu's alert list (polled by the UI).
2. **AutoTrade** (`src/autopilot.ts`, started by `/api/auto/start`) ran its **own** loop: pick a pool of markets, open a websocket per market, call `analyze` on each, wait for the whole pool, pick the best, look again, trade. Its message *"Checked 21 markets, no tradeable setup"* is the log line of that loop (`autopilot.ts`, scan branch). It never read the agents' output, so it could report "no setup" while the agents had one on screen, and it needed its own screenshot / Gemini call per market.

## What changed

On **Deriv** (the markets the agents watch) AI Trading now runs in **agent mode**:

```
agents (unchanged, always running) → candidate hub → 3 engines + Gemini (same screenshot, concurrently)
      → coordinator decision → AutoTrade subscribed to approved setups → final safety gate → broker order
```

* `Autopilot.start()` takes the `startAgentDriven()` branch when it is given an `agentSource`. That branch has **no market pool, no `watch` per market, no `analyze` scan, no rescan timer**. It waits for approved setups and trades them one at a time (existing stake, MTG, limits and result tracking are the same code).
* `src/agentSource.ts` subscribes to the hub's decisions. Registering a listener with the same name **replaces** it, so ON → OFF → ON never duplicates subscriptions.
* `src/agentMode.ts`: one switch. ON: the coordinator verifies the agents' candidates (engines + Gemini). OFF: the agents keep monitoring and publishing, but nothing goes to Gemini and no order can follow. Switching it never starts, stops or restarts an agent.
* `analyze` in agent mode only **reads** the agents' decision for the candle (`lookFromAgents`); it never fetches, scans, draws a screenshot or calls Gemini. No agent setup = no trade.
* Candidate fields: agent id, market symbol, BUY/SELL, pattern name, candidate id, M5 open + close time, detection time, screenshot + its timestamp, OHLC, candle-set hash, entry price, validity (see `CandidateEvidence`).
* Kept: the 45 s `MAX_ENTRY_DELAY_SEC` (not changed), the execution gate (`runExecutionGate`), AI policy, duplicate ledger, broker connection check, stake / loss limits. Every order is re-checked (`executionCheck`: invalidated, stale, already executed, hash mismatch) in `preflight` and again at `place`.
* **Other brokers** (Pocket, Quotex, IQ Option) have no agents, so they keep the original scan loop. The old scanner (`/api/scan`, Classic/Signals pages) is untouched; it just is not part of agent-driven AutoTrade.
* AutoTrade follows the agents' candle size (`SWEEP_TF`, default M5). If the agents are not running, starting AI Trading on Deriv returns "The market agents are not running".

## Dashboard (Pro Mode → AI Trading, live card)

Active agents · setups detected · sent to engines + AI · engine analyses · AI analyses · approved · rejected · expired · trades executed · wins · losses, plus a live feed of real states, e.g.
`AGENT DETECTED → Market → BUY → Buy Momentum - 3 Green Candles, Body Dominance` → `SCREENSHOT SENT` → `ENGINE 1/2/3 → BUY | NO SIGNAL | SKIP | OPPOSITE` → `GEMINI → APPROVED | NOT APPROVED (reason)` → `FINAL VALIDATION → PASSED | REJECTED: reason | CANCELLED` → `BROKER → BUY ORDER SUBMITTED` → `TRADE → EXECUTED`. Counters start from zero each time AutoTrade is switched on. "Expired" = rejected/dropped for being stale, invalidated before the order, or too old by the time AutoTrade was free.

## Files

New: `src/agentMode.ts`, `src/agentSource.ts`, `src/autotradeFeed.ts`, `src/agentAutotrade.test.ts` (and the candidate-hub files from `docs/CANDIDATE_BROADCAST.md`).
Changed: `src/autopilot.ts` (agent mode, `listening` phase, `agent` state), `autoServer.ts` (builds the agent source for Deriv, agent-mode `analyze`, order events), `candidateServer.ts` (coordinator enabled only while AutoTrade is on), `src/candidateHub.ts` (events, pattern name), `src/candidateLook.ts` (`lookFromAgents`), `src/verificationCoordinator.ts` (`enabled`), `src/candidateTypes.ts` (pattern), `src/AutopilotUI.tsx`, `src/ProMode.tsx`, `src/styles.css`.

## Tests (`npm run test:candidates`; whole suite: `npx tsx --test src/*.test.ts` → 287 pass)

`src/agentAutotrade.test.ts` has the 14 required checks using the real agents, hub, coordinator, three engines, signal pipeline and autopilot, with fake broker feed / order call / clock / Gemini: ON starts no scanner (0 market lists, 0 watches, 0 analyses); agents keep fetching ON/OFF/ON; agent setups trade automatically; all three engines and Gemini get the agent's screenshot (same PNG hash / same object); four analyses overlap in time; a slow agent never delays another; approved → order (ledger + executed flag); rejected → no order and the reason is shown; duplicate events → one trade; stale and faded (invalidated) setups cannot execute; OFF blocks Gemini + orders while agents continue; repeated ON/OFF leaves exactly one listener each.

## Limits you should know

* **Not run against live Deriv / Gemini from here.** The server wiring (`autoServer.ts`, `place`) needs `ws`/`express`, which are not installed in this sandbox, so it was type-checked and reviewed but not executed; the same logic is exercised in the tests through equivalent fake deps. Please run one demo-account session first.
* One trade at a time (unchanged autopilot behaviour: MTG and loss limits depend on it). Setups approved while a trade is open are dropped as expired once they pass 45 s; they are never queued for a late entry.
* Gemini spacing (12 s) still limits how many simultaneous candidates can be verified inside 45 s; the freshest go first, the rest are rejected as stale rather than traded late.
