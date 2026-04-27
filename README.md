# Cadence - Patient Voice Agent

A single-page simulator for Cadence, an inbound patient voice agent. Use Case A handles medication refills against a Salesforce-backed object model. Built as a portfolio piece for a Senior PM role in Healthcare AI.

## What it shows

Six end-to-end scenarios fire through an 8-state machine. Five end in escalation, each with a typed `EscalationContext` payload routed to a human specialist. The state machine separates **deterministic** authority (5 states - identity, validation, persistence) from **scoped LLM** authority (2 states - disambiguation, pharmacy read-back). The LLM never speaks before identity is verified and never speaks at all when a controlled medication is detected.

## Scenarios

| Scenario | Reason code | Rule |
|---|---|---|
| Happy path | - | All 8 states fire, ends clean |
| Controlled medication | `controlled_medication` | R2 - escalate pre-LLM |
| DOB mismatch ×2 | `dob_failure` | R1 - zero disclosure |
| Ambiguous medication | `disambiguation_failed` | R4 - 2-retry cap |
| Inactive medication | `no_active_medications` | R3 - block + escalate |
| API failure on submit | `api_failure` | R7 - 2 failures → escalate |

## Stack

React 18 + Vite + Tailwind + lucide-react. Single component (`src/pages/Index.tsx`). No router, no state library, no UI kit - the simulator is intentionally one file so the state machine, scenarios, and rendering can be read end-to-end.

## What this simulator does NOT model

- The input-layer scope classifier (R8). Out-of-domain utterances would be rejected before reaching IDENTIFY.
- HMAC token TTL enforcement. The header chip is illustrative.
- Per-state retry counters and the 10-transition session cap (R6) as live runtime guards. Scenarios encode the failure modes; the runtime does not yet enforce them.
- R7 (API resilience) is shown as a scenario but is not a hard rule in the design doc - it's a behavior baked into CREATE_REFILL.
- Spanish-language path (`Preferred_Language__c=Spanish`).
- Human-handoff failure modes (queue full, no specialist available).

## Companion design doc

The full agent design (object model, state authority table, hard rules R1–R6, latency budget, ASR considerations, single-agent auth risks, test strategy) is in the accompanying design doc submitted alongside this repo.
