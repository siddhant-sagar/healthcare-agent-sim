# Healthcare AI Voice Agent Simulator — Build Plan

A single-screen, fixed-layout interactive simulator demonstrating a deterministic state machine for medication refills. Optimized to communicate PM-level depth in 90 seconds.

## What gets built

One file: `src/pages/Index.tsx` — a self-contained React component rendering the entire simulator. Existing `Index.tsx` placeholder gets fully replaced. No routing changes, no new dependencies.

## Layout (fixed, no page scroll @ 1440×900)

```text
┌─────────────────────────────────────────────────────────────────────┐
│ HEADER (56px)  logo · Refill Agent · Use Case A · v0.4   · live ·  │
├──────────┬──────────────────────────────────┬───────────────────────┤
│          │                                  │                       │
│ SCENARIO │   STATE MACHINE                  │  PATIENT VIEW         │
│ PICKER   │   8 stacked state rows w/        │  italic gray msgs     │
│ 260px    │   colored status badges          │  ───────────────      │
│          │   + per-state tool / latency     │  ON ESCALATION:       │
│ 6 cards  │                                  │  full takeover →      │
│          │   ─ Hard Rules Ribbon ─          │  reason chip          │
│          │   R1 R2 R3 R4 R6 chips           │  JSON payload         │
│          │                                  │  rule citation        │
│          │                                  │  receiving agent      │
│          │                                  │  360px                │
├──────────┴──────────────────────────────────┴───────────────────────┤
│ FOOTER (44px) states X/8 · tokens N · latency Nms · audit N events │
└─────────────────────────────────────────────────────────────────────┘
       ↑ clicking "audit N events" slides up a 200px drawer
```

`grid-cols-[260px_1fr_360px]`. Center and right columns each `overflow-y-auto`; `body`/root locked to `h-screen overflow-hidden`.

## Visual system

- **Background**: `#0a0e14` root, `#0d121a` header + left panel, `#0b1018` right panel.
- **Center grid texture**: two `linear-gradient` lines on a 32px grid at 4% slate opacity (inline style).
- **Fonts**: `<style>` tag inside the component imports Inter (400/500/600/700) and JetBrains Mono (400/500/600) from Google Fonts. Inter for chrome. JetBrains Mono for every state ID, metric value, uppercase 9–10px `tracking-widest` label, and JSON.
- **Type scale**: nothing larger than 14px. Body 11–13px. Section labels 9–10px mono uppercase.
- **State colors** (always paired bg/border/text):
  - Deterministic active → `bg-blue-500/10 border-blue-500/30 text-blue-300`
  - LLM active → `bg-amber-500/10 border-amber-500/30 text-amber-300`
  - Escalation → `bg-red-500/10 border-red-500/30 text-red-300`
  - Complete → `bg-emerald-500/10 border-emerald-500/30 text-emerald-300`
  - Inactive → `bg-slate-800/40 border-slate-700/50 text-slate-500`
- **Borders**: `border-slate-800/80`. Corners sharp or `rounded-[4px]` max.
- No emojis, no shadows except a faint glow on the active state, no gradients except an 8×8 logo mark.

## Header

Left: 8×8 gradient mark + `Refill Agent · Use Case A · Voice Inbound · v0.4` (Inter, slate-200/slate-500 mix).
Right (mono uppercase 9px, space-separated): green pulsing dot `SESSION LIVE` · `HMAC TTL 600s` · `PHI-REDACTED LOG`.

## Left — Scenario Picker

Six button cards, each with: title (Inter 12px medium), one-line blurb (slate-500 11px), and a mono uppercase sticker tag in the corner.

| Title | Sticker | Behavior |
|---|---|---|
| Happy path refill | BASELINE | Runs all 8 states → green COMPLETE |
| Controlled medication | HARD STOP | Active card gets faint red tint; VALIDATE_MED pulses red, takeover |
| DOB mismatch ×2 | IDENTITY | VERIFY_DOB ×3 → escalate, zero med disclosure |
| Ambiguous medication | LLM LIMIT | SELECT_MED ×3 (Metformin/Metoprolol) → disambiguation_failed |
| Inactive medication | ELIGIBILITY | VALIDATE_MED detects Active=false → escalate |
| API failure on submit | RESILIENCE | CREATE_REFILL 503 ×2 → escalate, latency tips red |

Selecting any card resets state and starts playback. No reset button.

## Center — State Machine

Eight vertically stacked rows, all visible simultaneously. Each row:
- Index `01`–`08` in mono dim slate
- State name in mono uppercase tracking-widest (`IDENTIFY`, `VERIFY_DOB`, …)
- Authority tag: `DETERMINISTIC` or `LLM` in tiny mono
- Right side: tool name + latency + token count once executed (mono)
- Status badge styled per the color rules above
- Active state has slide-in (0.25s ease-out, translate-x + opacity)
- VALIDATE_MED in controlled scenario gets a CSS keyframe pulse:
  ```text
  0%   box-shadow 0 0 0 0   rgba(239,68,68,0.4)
  50%  box-shadow 0 0 0 8px rgba(239,68,68,0)
  100% box-shadow 0 0 0 0   rgba(239,68,68,0.4)
  ```
  duration 1.4s infinite.

**Hard Rules Ribbon** (always visible, below states): row of mono chips `R1 · DOB before disclosure`, `R2 · Controlled→escalate`, `R3 · Inactive→block`, `R4 · 2-retry cap`, `R6 · 10-transition cap`.

## Right — Patient View / Human Handoff

**Default mode (Patient View):**
- Section header `PATIENT VIEW` mono uppercase
- Each scripted patient-facing line appended in italic slate-400, left-bordered slate-700, 11–12px.

**Escalation takeover** (full panel replace):
- Red header bar with `AlertTriangle` (lucide), title `EscalationContext received`
- `SAID TO PATIENT` — safe acknowledgment in italic gray, left-bordered
- `REASON CODE` — red pill with reason code in mono
- `CONTEXT PAYLOAD` — JSON block, bg `#070a10`, border slate-800. Syntax-colored manually: keys `blue-300`, string values `emerald-300`, braces/commas `slate-500`, numbers `amber-300`.
- `WHY` — slate card citing the verbatim rule (e.g. `R2 · Controlled__c=true escalates BEFORE Active__c check and BEFORE any LLM output.`)
- `RECEIVING AGENT` — small avatar circle + `Specialist · queue 02` + mono caption `context received · session ownership transferred`

EscalationContext payloads (rendered verbatim per reason code):

| Reason | Fields |
|---|---|
| patient_not_found | phone_hash, timestamp |
| dob_failure | patient_id, attempt_count, timestamp |
| controlled_medication | patient_id, medication_id, timestamp |
| api_failure | patient_id, medication_id, pharmacy_name, response_codes[], timestamp |
| disambiguation_failed (catch-all) | session_id, triggering_state, conversation_summary, tokens_used |

## Footer + Audit Drawer

Footer cells (mono): `STATES X/8` · `TOKENS N` · `LATENCY Nms` · `AUDIT N EVENTS` (clickable). Latency turns `text-red-400` once cumulative > 2000ms.

Audit drawer (200px, slides up over bottom of screen with CSS transform/transition):
- Monospace table columns: `#  STATE  TOOL  LATENCY  TOKENS  OUTCOME`
- One row per executed step. Outcome string for escalations is reason code in caps.
- Footer line inside drawer: `phi-redacted · inputs hashed · session sess_a91c33`

## Playback engine

`useEffect` chain: when active scenario set, walk its `steps[]` with `setTimeout(..., 600)`. Each step:
1. Mark state as active (status = its band color), clear previous active
2. Append patient-facing message (or skip if step is silent)
3. Append audit row (index, state, tool, latency_ms, tokens, outcome)
4. Increment cumulative tokens + latency footer

Cleanup on scenario change clears all pending timeouts.

**Mock metric calibration:**
- Tokens — deterministic: `40 + floor(rand*60)`; LLM (SELECT_MED, CONFIRM_PHARMACY): `180 + floor(rand*120)`; COMPLETE: 0
- Latency per state (matching design doc §9):
  - IDENTIFY ~210ms, VERIFY_DOB ~120ms, FETCH_MEDS ~310ms
  - SELECT_MED / CONFIRM_PHARMACY 380–460ms
  - VALIDATE_MED ~90ms, CREATE_REFILL ~420ms
- API failure scenario fires CREATE_REFILL twice (~420ms each) plus prior states → cumulative crosses 2000ms → footer latency tips red.

## Scenario data structure

A single `SCENARIOS` const array. Each scenario:
```text
{ id, title, sticker, blurb, steps: [
    { state, tool, patientLine?, latency, tokens, outcome },
    ...
    { escalate?: { reason, payload, ruleCitation, safeAck } }
] }
```
All "LLM" outputs are scripted strings — no API calls.

## Acceptance verification (built into the implementation)

- All 6 scenarios run end-to-end at 600ms cadence
- Color rules enforced via a single `statusClasses(status)` helper
- Root has `h-screen overflow-hidden`; only middle/right inner panels scroll
- Controlled scenario triggers red pulse + right-panel takeover
- All 5 escalation payload shapes match the table exactly
- Audit drawer toggles from footer with real rows
- Latency goes red on API failure scenario
- Imports: only `react` + `lucide-react`
- JetBrains Mono used for every state ID, metric value, uppercase label, JSON

## Technical notes

- Single file `src/pages/Index.tsx` fully replacing the placeholder.
- No changes to `App.tsx`, Tailwind config, or `index.css` — all custom styling done with arbitrary Tailwind values + one inline `<style>` block (Google Fonts import + the red pulse keyframe + center-grid background gradient).
- State managed with `useState` + `useRef` (timeout id list for cleanup) + `useEffect`.
- lucide-react icons used: `AlertTriangle`, `Phone`, `ShieldCheck`, `Pill`, `CheckCircle2`, `Activity`, `ChevronUp`, `Circle`, `User`.
- No new packages installed; both React and lucide-react are already in the project.