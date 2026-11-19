# Multi-agent candidate broadcast

The market agents already existed and already found setups and drew the chart. They never handed that evidence to the AI or the engines, so the
verification path re-did the work on its own. This change connects the two **without replacing either**.

## What was wrong (found by reading the code)

| Question | Finding | Now |
|---|---|---|
| Does anything push the agents' evidence to the engines / AI? | **No.** `sweepWatcher` only stored alerts for the Menu. Verification was pull-based: the autopilot / scanner called `getSignal`, which re-fetched candles, called `/api/engines`, **drew its own second screenshot** (`screenshot.ts`) and then called Gemini. | Agent publishes one candidate; every recipient gets the same frozen object. The AI request uses the agent's screenshot (`SignalDeps.image`); no second screenshot is drawn. |
| Wait for all markets? | `runPass` awaited every market (6 workers) before the loop slept to the next candle; a hung market had **no timeout** and stalled the whole pass. The autopilot `scan()` also awaits its whole pool before picking. | One independent loop per agent. Broker requests go through a shared 8-slot semaphore with a 20 s timeout, so one hung market cannot hold a slot. The autopilot reads the agent's decision instead of re-scanning that market. |
| One engine waits for another? | Engines ran inside one `/api/engines` request, then the AI. | Three engine recipients + the AI recipient start in the same tick and run side by side. |
| Gemini blocks other candidates? | Callers queue behind Gemini's 12 s slot spacing, oldest first. | Each candidate is its own async task. The AI goes through a freshest-first limiter (`CANDIDATE_AI_CONCURRENCY`, default 2) that **skips** candidates that can no longer be traded. |
| Hybrid blocks other markets? | It runs inside `getSignal`, per candidate. | Same, but now off the agents' path. |

## Flow

```
market agent (one loop each) ── closed M5 candle ── 3 engines find a TAKE setup
   └─ draw chart once (sweepChart) → PNG → publish(candidate v1)           candidateHub.publish
        ├─ engine:sweep ─────────┐
        ├─ engine:continuation ──┤  same frozen evidence, same tick,
        ├─ engine:momentum ──────┤  each answer = (candidateId, version, candleSetHash)
        └─ ai  = signalServer.getSignal (pattern check, Gemini + the agent's screenshot, hybrid gate, policy)
                                   └─ coordinator.aggregate → ONE decision: EXECUTE | REJECT | CANCELLED
agent keeps watching: while a candidate is live it re-reads the chart every 5 s → hub.update → version 2, 3 … (version 1 never replaced)
AutoTrade (Deriv, agent mode, see docs/AGENT_AUTOTRADE.md): receives the approved decision → autoLook → preflight (executionCheck again) → order → markExecuted
```

A candidate carries: candidate id, agent id, market, direction, engine, M5 candle open/close time, screenshot timestamp, candle-set hash
(all rows) and AI-rows hash (the 60 rows in the prompt, also printed on the screenshot request), evidence version, validity.

## Guarantees

* **Same evidence for everyone** – the object is frozen; the tests assert every recipient holds the identical reference.
* **Mismatched evidence is rejected** – a result with a wrong version or hash is refused and counted as a failed recipient; an AI that inspected another PNG or other rows rejects the candidate; a screenshot that does not end on the signal candle or does not match the 60 rows is refused (`AI_UNAVAILABLE`, Gemini not called).
* **Nothing is silently replaced** – updates are new versions with their own screenshot, timestamp and hash; the original and the audit trail stay.
* **Invalidation** – an update that revises a pattern candle, drops the signal candle, contains inconsistent data, or makes the original engine stop firing marks the candidate `INVALIDATED` and cancels its decision immediately, even while the AI is still running. A late approval cannot revive it. Newer candles alone do not invalidate (freshness handles that).
* **Freshness** – `executionCheck` (used by the coordinator, by `analyze` and again in `preflight`) refuses a candidate that is not closed yet, is older than `MAX_ENTRY_DELAY_SEC`, was invalidated, was already executed, or whose decision no longer matches the stored hash. The AI is not even called for a candidate that is already too old.
* **Duplicates** – one candidate per market + timeframe + signal candle + direction. A repeat is `DUPLICATE`, a second engine on the same opportunity is `MERGED` (one verification, one order). The existing execution ledger still guards the order itself.
* **Safety is not weakened** – strategy rules, the chart renderer, hybrid gate, AI policy, execution gate and the UI are unchanged. The AI/hybrid pipeline is the same `getSignal`; a missing or broken AI is still never an approval.

## Latency

`GET /api/candidates/metrics` → count / min / p50 / p95 / max / last (ms) for: `detection` (candle close → detected, broker clock), `screenshot`, `broadcast`, `engine:sweep|continuation|momentum`, `ai`, `aggregation`, `execution` (decision → order sent), plus counters (published, duplicates, merged, rejected, updates, invalidated, inconsistentResults, decisions, executed).
Audit: `GET /api/candidates`, `GET /api/candidates/:id` (versions, hashes, every result, decision history), `GET /api/candidates/:id/screenshot?version=N[&format=svg]`.

## Settings (`.env.example`)

`SWEEP_TF` (default **300** = completed M5 candles; this was 60 before), `CANDIDATE_AI_CONCURRENCY` (2), `CANDIDATE_AI_TIMEOUT_MS` (60000), `MAX_ENTRY_DELAY_SEC` (45, existing).

## Things to know

* The AI/Gemini step is still limited by your Gemini plan (12 s spacing by default). With a 45 s entry window only a few candidates per candle can finish in time; the freshest are served first and the rest are rejected as stale rather than traded late. Raise `MAX_ENTRY_DELAY_SEC` and `GEMINI_MIN_INTERVAL_MS` only if you accept the later entry.
* The agents watch the Deriv markets (29 agents in `SWEEP_AGENTS`; nothing in the code depends on the count). For other brokers `analyze` uses the original scan-and-verify path unchanged. If the autopilot scans a market in the first seconds after a close, before the agent has published, it also falls back to that path for that candle.
* Candidate screenshots need a rasterizer (`@resvg/resvg-js`, already in `package.json`). Without one the AI reports the screenshot as `NOT_SENT` and, with the default policy, nothing trades.
* Verified with the unit tests and fakes for the broker feed, the clock and Gemini. It has **not** been run against live Deriv / Gemini from here.

Tests: `npm run test:candidates` (new file: `src/candidateBroadcast.test.ts`, 20 tests covering simultaneous agents, immediate broadcast, identical evidence, Gemini screenshot, parallel engines, slow AI / hung markets, live updates, version and hash validation, invalidation, duplicates, freshness, latency).
