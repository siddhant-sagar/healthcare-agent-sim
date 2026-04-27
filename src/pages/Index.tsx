import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Activity,
  ChevronUp,
  ChevronDown,
  Phone,
  ShieldCheck,
  Pill,
  CheckCircle2,
  Circle,
  User,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Authority = "DETERMINISTIC" | "LLM" | "—";
type Status = "idle" | "deterministic" | "llm" | "escalation" | "complete";

type ReasonCode =
  | "patient_not_found"
  | "dob_failure"
  | "controlled_medication"
  | "disambiguation_failed"
  | "no_active_medications"
  | "api_failure"
  | "runaway_detected";

type Step = {
  state: StateId | "ESCALATE";
  tool: string;
  patientLine?: string;
  latency: number;
  tokens: number;
  outcome: string;
  /** if present, fires escalation takeover after this step */
  escalate?: {
    reason: ReasonCode;
    payload: Record<string, unknown>;
    ruleCitation: string;
    safeAck: string;
  };
  /** for controlled scenario: pulse this state red */
  pulseRed?: boolean;
};

type StateId =
  | "IDENTIFY"
  | "VERIFY_DOB"
  | "FETCH_MEDS"
  | "SELECT_MED"
  | "VALIDATE_MED"
  | "CONFIRM_PHARMACY"
  | "CREATE_REFILL"
  | "COMPLETE";

type Scenario = {
  id: string;
  title: string;
  sticker: string;
  blurb: string;
  accentRed?: boolean;
  steps: Step[];
};

const STATES: { id: StateId; authority: Authority }[] = [
  { id: "IDENTIFY", authority: "DETERMINISTIC" },
  { id: "VERIFY_DOB", authority: "DETERMINISTIC" },
  { id: "FETCH_MEDS", authority: "DETERMINISTIC" },
  { id: "SELECT_MED", authority: "LLM" },
  { id: "VALIDATE_MED", authority: "DETERMINISTIC" },
  { id: "CONFIRM_PHARMACY", authority: "LLM" },
  { id: "CREATE_REFILL", authority: "DETERMINISTIC" },
  { id: "COMPLETE", authority: "—" },
];

/* ------------------------------------------------------------------ */
/*  Mock metric helpers — calibrated bands                             */
/* ------------------------------------------------------------------ */

const detTok = () => 40 + Math.floor(Math.random() * 60);
const llmTok = () => 180 + Math.floor(Math.random() * 120);
const llmLat = () => 380 + Math.floor(Math.random() * 80);

/* ------------------------------------------------------------------ */
/*  Scenarios                                                          */
/* ------------------------------------------------------------------ */

const SCENARIOS: Scenario[] = [
  {
    id: "happy",
    title: "Happy path refill",
    sticker: "BASELINE",
    blurb: "All 8 states fire, completes green.",
    steps: [
      { state: "IDENTIFY", tool: "get_patient_by_phone", latency: 212, tokens: detTok(),
        outcome: "200 OK · pid=p_44910",
        patientLine: "Hi, this is the refill line. I have your number on file." },
      { state: "VERIFY_DOB", tool: "validate_dob", latency: 118, tokens: detTok(),
        outcome: "match · token issued",
        patientLine: "Could you please verify your date of birth?" },
      { state: "FETCH_MEDS", tool: "SOQL Medication__c", latency: 308, tokens: detTok(),
        outcome: "3 rows" },
      { state: "SELECT_MED", tool: "llm.disambiguate", latency: llmLat(), tokens: llmTok(),
        outcome: "conf=0.94 · Atorvastatin",
        patientLine: "I see three active medications. Which would you like to refill?" },
      { state: "VALIDATE_MED", tool: "—", latency: 87, tokens: detTok(),
        outcome: "Controlled=false · Active=true" },
      { state: "CONFIRM_PHARMACY", tool: "llm.confirm", latency: llmLat(), tokens: llmTok(),
        outcome: "confirmed · Walgreens #4421",
        patientLine: "Sending to Walgreens on Kirkland Avenue, correct?" },
      { state: "CREATE_REFILL", tool: "POST /refills", latency: 418, tokens: detTok(),
        outcome: "201 Created · rx_88a2",
        patientLine: "Your refill is submitted. You'll get an SMS when it's ready." },
      { state: "COMPLETE", tool: "—", latency: 12, tokens: 0,
        outcome: "session closed · clean" },
    ],
  },
  {
    id: "controlled",
    title: "Controlled medication",
    sticker: "HARD STOP",
    blurb: "Validate detects Controlled=true → immediate escalate.",
    accentRed: true,
    steps: [
      { state: "IDENTIFY", tool: "get_patient_by_phone", latency: 207, tokens: detTok(),
        outcome: "200 OK · pid=p_55021",
        patientLine: "Hi, this is the refill line. I have your number on file." },
      { state: "VERIFY_DOB", tool: "validate_dob", latency: 122, tokens: detTok(),
        outcome: "match · token issued",
        patientLine: "Could you verify your date of birth, please?" },
      { state: "FETCH_MEDS", tool: "SOQL Medication__c", latency: 311, tokens: detTok(),
        outcome: "2 rows" },
      { state: "SELECT_MED", tool: "llm.disambiguate", latency: llmLat(), tokens: llmTok(),
        outcome: "conf=0.91 · matched id=m_771",
        patientLine: "Which medication would you like to refill today?" },
      { state: "VALIDATE_MED", tool: "—", latency: 91, tokens: detTok(),
        outcome: "Controlled=true → ESCALATE",
        pulseRed: true,
        escalate: {
          reason: "controlled_medication",
          payload: {
            patient_id: "p_55021",
            medication_id: "m_771",
            timestamp: "2026-04-27T13:31:08Z",
          },
          ruleCitation:
            "R2 · Controlled__c=true escalates BEFORE Active__c check and BEFORE any LLM output.",
          safeAck: "I need to connect you with a specialist who can assist with this request.",
        } },
    ],
  },
  {
    id: "dob",
    title: "DOB mismatch ×2",
    sticker: "IDENTITY",
    blurb: "Two mismatches, then escalate. Zero medication disclosure.",
    steps: [
      { state: "IDENTIFY", tool: "get_patient_by_phone", latency: 214, tokens: detTok(),
        outcome: "200 OK · pid=p_30188",
        patientLine: "Hi, this is the refill line." },
      { state: "VERIFY_DOB", tool: "validate_dob", latency: 121, tokens: detTok(),
        outcome: "mismatch · attempt 1/2",
        patientLine: "Could you please verify your date of birth?" },
      { state: "VERIFY_DOB", tool: "validate_dob", latency: 119, tokens: detTok(),
        outcome: "mismatch · attempt 2/2",
        patientLine: "I didn't get a match. Let's try once more — your date of birth?" },
      { state: "VERIFY_DOB", tool: "validate_dob", latency: 117, tokens: detTok(),
        outcome: "mismatch → ESCALATE",
        escalate: {
          reason: "dob_failure",
          payload: {
            patient_id: "p_30188",
            attempt_count: 2,
            timestamp: "2026-04-27T13:31:08Z",
          },
          ruleCitation:
            "R1 · DOB must be verified before any medication field, name, or count is disclosed.",
          safeAck: "I was unable to verify your identity. Let me connect you with a specialist.",
        } },
    ],
  },
  {
    id: "ambig",
    title: "Ambiguous medication",
    sticker: "LLM LIMIT",
    blurb: "SELECT_MED 3× on Metformin / Metoprolol → cap hit.",
    steps: [
      { state: "IDENTIFY", tool: "get_patient_by_phone", latency: 209, tokens: detTok(),
        outcome: "200 OK · pid=p_71223",
        patientLine: "Hi, this is the refill line." },
      { state: "VERIFY_DOB", tool: "validate_dob", latency: 120, tokens: detTok(),
        outcome: "match · token issued",
        patientLine: "Could you verify your date of birth?" },
      { state: "FETCH_MEDS", tool: "SOQL Medication__c", latency: 312, tokens: detTok(),
        outcome: "4 rows" },
      { state: "SELECT_MED", tool: "llm.disambiguate", latency: llmLat(), tokens: llmTok(),
        outcome: "conf=0.52 · ambiguous",
        patientLine: "Did you mean Metformin or Metoprolol?" },
      { state: "SELECT_MED", tool: "llm.disambiguate", latency: llmLat(), tokens: llmTok(),
        outcome: "conf=0.49 · ambiguous · retry 1/2",
        patientLine: "Sorry — could you spell the first three letters?" },
      { state: "SELECT_MED", tool: "llm.disambiguate", latency: llmLat(), tokens: llmTok(),
        outcome: "retry 2/2 → ESCALATE",
        escalate: {
          reason: "disambiguation_failed",
          payload: {
            session_id: "sess_a91c33",
            triggering_state: "SELECT_MED",
            conversation_summary:
              "patient referenced 'met-' medication; 2 LLM retries could not disambiguate Metformin vs Metoprolol",
            tokens_used: 742,
          },
          ruleCitation: "R4 · SELECT_MED disambiguation capped at 2 retries.",
          safeAck:
            "Let me connect you with a team member who can assist you directly.",
        } },
    ],
  },
  {
    id: "inactive",
    title: "Inactive medication",
    sticker: "ELIGIBILITY",
    blurb: "Active__c flipped between fetch and validate — block + escalate.",
    steps: [
      { state: "IDENTIFY", tool: "get_patient_by_phone", latency: 211, tokens: detTok(),
        outcome: "200 OK · pid=p_60412",
        patientLine: "Hi, this is the refill line." },
      { state: "VERIFY_DOB", tool: "validate_dob", latency: 119, tokens: detTok(),
        outcome: "match · token issued",
        patientLine: "Could you verify your date of birth?" },
      { state: "FETCH_MEDS", tool: "SOQL Medication__c", latency: 309, tokens: detTok(),
        outcome: "2 rows" },
      { state: "SELECT_MED", tool: "llm.disambiguate", latency: llmLat(), tokens: llmTok(),
        outcome: "conf=0.96 · Lisinopril",
        patientLine: "Which medication would you like to refill?" },
      { state: "VALIDATE_MED", tool: "—", latency: 92, tokens: detTok(),
        outcome: "Active=false → ESCALATE",
        escalate: {
          reason: "no_active_medications",
          payload: {
            session_id: "sess_a91c33",
            triggering_state: "VALIDATE_MED",
            conversation_summary:
              "Lisinopril was Active=true at FETCH_MEDS but flipped to Active=false at VALIDATE_MED",
            tokens_used: 386,
          },
          ruleCitation:
            "R3 · Active__c=false → block refill, escalate to a human.",
          safeAck:
            "Let me connect you with a team member who can assist you directly.",
        } },
    ],
  },
  {
    id: "api",
    title: "API failure on submit",
    sticker: "RESILIENCE",
    blurb: "POST /refills 503 ×2 → escalate. Latency tips red.",
    steps: [
      { state: "IDENTIFY", tool: "get_patient_by_phone", latency: 215, tokens: detTok(),
        outcome: "200 OK · pid=p_82001",
        patientLine: "Hi, this is the refill line." },
      { state: "VERIFY_DOB", tool: "validate_dob", latency: 124, tokens: detTok(),
        outcome: "match · token issued",
        patientLine: "Could you verify your date of birth?" },
      { state: "FETCH_MEDS", tool: "SOQL Medication__c", latency: 314, tokens: detTok(),
        outcome: "3 rows" },
      { state: "SELECT_MED", tool: "llm.disambiguate", latency: llmLat(), tokens: llmTok(),
        outcome: "conf=0.95 · Atorvastatin",
        patientLine: "Which would you like to refill today?" },
      { state: "VALIDATE_MED", tool: "—", latency: 89, tokens: detTok(),
        outcome: "Controlled=false · Active=true" },
      { state: "CONFIRM_PHARMACY", tool: "llm.confirm", latency: llmLat(), tokens: llmTok(),
        outcome: "confirmed · CVS #1188",
        patientLine: "Sending to CVS on 4th, correct?" },
      { state: "CREATE_REFILL", tool: "POST /refills", latency: 422, tokens: detTok(),
        outcome: "503 Service Unavailable · retry 1/2" },
      { state: "CREATE_REFILL", tool: "POST /refills", latency: 431, tokens: detTok(),
        outcome: "503 → ESCALATE",
        escalate: {
          reason: "api_failure",
          payload: {
            patient_id: "p_82001",
            medication_id: "m_4421",
            pharmacy_name: "CVS #1188",
            response_codes: [503, 503],
            timestamp: "2026-04-27T13:31:08Z",
          },
          ruleCitation:
            "R7 · POST /refills must return 2xx; ≥2 failures → api_failure escalation.",
          safeAck:
            "I encountered an issue submitting your request. Connecting you to complete this.",
        } },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Visual helpers                                                     */
/* ------------------------------------------------------------------ */

const statusClasses = (s: Status, pulseRed = false) => {
  if (pulseRed) {
    return "bg-red-500/15 border-red-500/50 text-red-300 pulse-red";
  }
  switch (s) {
    case "deterministic":
      return "bg-blue-500/10 border-blue-500/30 text-blue-300";
    case "llm":
      return "bg-amber-500/10 border-amber-500/30 text-amber-300";
    case "escalation":
      return "bg-red-500/10 border-red-500/30 text-red-300";
    case "complete":
      return "bg-emerald-500/10 border-emerald-500/30 text-emerald-300";
    default:
      return "bg-slate-800/40 border-slate-700/50 text-slate-500";
  }
};

const authorityToStatus = (a: Authority): Status => {
  if (a === "LLM") return "llm";
  if (a === "DETERMINISTIC") return "deterministic";
  return "complete";
};

/* ------------------------------------------------------------------ */
/*  JSON renderer — manual syntax highlight                            */
/* ------------------------------------------------------------------ */

function JsonBlock({ data }: { data: unknown }) {
  const lines = JSON.stringify(data, null, 2).split("\n");
  return (
    <pre className="font-mono text-[11px] leading-[1.55] bg-[#070a10] border border-slate-800/80 rounded-[4px] p-3 overflow-x-auto">
      {lines.map((line, i) => (
        <div key={i}>{colorize(line)}</div>
      ))}
    </pre>
  );
}

function colorize(line: string) {
  // match  "key": value
  const m = line.match(/^(\s*)("?)([^":]+?)("?)(\s*:\s*)(.*)$/);
  if (!m || !line.includes(":")) {
    return <span className="text-slate-500">{line}</span>;
  }
  const [, indent, q1, key, q2, colon, rest] = m;
  return (
    <>
      <span className="text-slate-500">{indent}</span>
      <span className="text-blue-300">{q1}{key}{q2}</span>
      <span className="text-slate-500">{colon}</span>
      {colorizeValue(rest)}
    </>
  );
}

function colorizeValue(v: string) {
  // strip trailing comma
  const trailing = v.endsWith(",") ? "," : "";
  const body = trailing ? v.slice(0, -1) : v;
  if (/^".*"$/.test(body)) {
    return (
      <>
        <span className="text-emerald-300">{body}</span>
        <span className="text-slate-500">{trailing}</span>
      </>
    );
  }
  if (/^-?\d+(\.\d+)?$/.test(body)) {
    return (
      <>
        <span className="text-amber-300">{body}</span>
        <span className="text-slate-500">{trailing}</span>
      </>
    );
  }
  if (body === "{" || body === "}" || body === "[" || body === "]") {
    return (
      <>
        <span className="text-slate-400">{body}</span>
        <span className="text-slate-500">{trailing}</span>
      </>
    );
  }
  // arrays inline like [503, 503]
  if (/^\[.*\]$/.test(body)) {
    return (
      <>
        <span className="text-amber-300">{body}</span>
        <span className="text-slate-500">{trailing}</span>
      </>
    );
  }
  return (
    <>
      <span className="text-slate-300">{body}</span>
      <span className="text-slate-500">{trailing}</span>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

type AuditRow = {
  idx: number;
  state: string;
  tool: string;
  latency: number | null;
  tokens: number | null;
  outcome: string;
};

type StateRuntime = {
  status: Status;
  tool?: string;
  latency?: number;
  tokens?: number;
  pulseRed?: boolean;
};

const RULES = [
  "R1 · DOB before disclosure",
  "R2 · Controlled→escalate",
  "R3 · Inactive→block",
  "R4 · 2-retry cap",
  "R6 · 10-transition cap",
];

const RULE_CITATIONS: Record<ReasonCode, string> = {
  patient_not_found:
    "R0 · Patient lookup returned null → escalate before any further state.",
  dob_failure: "R1 · DOB before disclosure.",
  controlled_medication:
    "R2 · Controlled__c=true escalates BEFORE Active__c check and BEFORE any LLM output.",
  no_active_medications: "R3 · Active__c=false → block refill, escalate.",
  disambiguation_failed: "R4 · SELECT_MED disambiguation capped at 2 retries.",
  api_failure: "R7 · ≥2 failed POST /refills → api_failure escalation.",
  runaway_detected: "R6 · session cap 10 transitions → runaway_detected.",
};

const Index = () => {
  const [scenarioId, setScenarioId] = useState<string>("happy");
  const [runtime, setRuntime] = useState<Record<StateId, StateRuntime>>(
    () => Object.fromEntries(STATES.map((s) => [s.id, { status: "idle" as Status }])) as Record<StateId, StateRuntime>,
  );
  const [activeIdx, setActiveIdx] = useState(-1);
  const [patientLines, setPatientLines] = useState<string[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [tokensTotal, setTokensTotal] = useState(0);
  const [latencyTotal, setLatencyTotal] = useState(0);
  const [statesVisited, setStatesVisited] = useState(0);
  const [escalation, setEscalation] = useState<Step["escalate"] | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const timeoutsRef = useRef<number[]>([]);

  const scenario = useMemo(
    () => SCENARIOS.find((s) => s.id === scenarioId)!,
    [scenarioId],
  );

  // playback
  useEffect(() => {
    // reset
    timeoutsRef.current.forEach((t) => clearTimeout(t));
    timeoutsRef.current = [];
    setRuntime(
      Object.fromEntries(STATES.map((s) => [s.id, { status: "idle" as Status }])) as Record<StateId, StateRuntime>,
    );
    setActiveIdx(-1);
    setPatientLines([]);
    setAudit([]);
    setTokensTotal(0);
    setLatencyTotal(0);
    setStatesVisited(0);
    setEscalation(null);

    const visited = new Set<StateId>();

    scenario.steps.forEach((step, i) => {
      const t = window.setTimeout(() => {
        const isEscalateRow = !!step.escalate;
        // status logic
        setRuntime((prev) => {
          const next = { ...prev };
          // turn previous deterministic/llm states "complete" if they completed
          (Object.keys(next) as StateId[]).forEach((k) => {
            if (next[k].status === "deterministic" || next[k].status === "llm") {
              if (k !== step.state) {
                next[k] = { ...next[k], status: "complete" };
              }
            }
          });
          if (step.state !== "ESCALATE") {
            const meta = STATES.find((s) => s.id === step.state)!;
            const isComplete = step.state === "COMPLETE";
            const baseStatus: Status = isEscalateRow
              ? "escalation"
              : isComplete
                ? "complete"
                : authorityToStatus(meta.authority);
            next[step.state] = {
              status: baseStatus,
              tool: step.tool,
              latency: step.latency,
              tokens: step.tokens,
              pulseRed: step.pulseRed,
            };
          }
          return next;
        });

        if (step.state !== "ESCALATE" && !visited.has(step.state)) {
          visited.add(step.state);
          setStatesVisited(visited.size);
        }
        setActiveIdx(i);

        if (step.patientLine) {
          setPatientLines((prev) => [...prev, step.patientLine!]);
        }
        setTokensTotal((p) => p + step.tokens);
        setLatencyTotal((p) => p + step.latency);
        setAudit((prev) => [
          ...prev,
          {
            idx: prev.length + 1,
            state: step.state,
            tool: step.tool,
            latency: step.latency || null,
            tokens: step.tokens || null,
            outcome: step.outcome,
          },
        ]);

        if (step.escalate) {
          // append synthetic escalate audit row
          setAudit((prev) => [
            ...prev,
            {
              idx: prev.length + 1,
              state: "—",
              tool: "escalate_to_human",
              latency: null,
              tokens: null,
              outcome: step.escalate!.reason.toUpperCase(),
            },
          ]);
          setEscalation(step.escalate);
        }
      }, 600 * (i + 1));
      timeoutsRef.current.push(t);
    });

    return () => {
      timeoutsRef.current.forEach((t) => clearTimeout(t));
      timeoutsRef.current = [];
    };
  }, [scenarioId, scenario.steps]);

  const latencyRed = latencyTotal > 2000;

  return (
    <div
      className="h-screen w-screen overflow-hidden text-slate-200 font-[Inter] text-[12px]"
      style={{ background: "#0a0e14" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .font-\\[Inter\\] { font-family: 'Inter', system-ui, sans-serif; }
        .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        @keyframes pulseRed {
          0%   { box-shadow: 0 0 0 0   rgba(239,68,68,0.45); }
          50%  { box-shadow: 0 0 0 8px rgba(239,68,68,0);    }
          100% { box-shadow: 0 0 0 0   rgba(239,68,68,0.45); }
        }
        .pulse-red { animation: pulseRed 1.4s ease-out infinite; }
        @keyframes dotPulse {
          0%,100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        .dot-pulse { animation: dotPulse 1.6s ease-in-out infinite; }
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(-6px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .slide-in { animation: slideIn 0.25s ease-out; }
        @keyframes drawerUp {
          from { transform: translateY(100%); }
          to   { transform: translateY(0); }
        }
        .drawer-up { animation: drawerUp 0.2s ease-out; }
        .center-grid {
          background-image:
            linear-gradient(to right,  rgba(148,163,184,0.04) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(148,163,184,0.04) 1px, transparent 1px);
          background-size: 32px 32px;
        }
        .scrollbar-thin::-webkit-scrollbar { width: 6px; height: 6px; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
        .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
      `}</style>

      <div className="grid h-full" style={{ gridTemplateRows: "56px 1fr 44px" }}>
        {/* HEADER */}
        <header
          className="flex items-center justify-between px-4 border-b border-slate-800/80"
          style={{ background: "#0d121a" }}
        >
          <div className="flex items-center gap-3">
            <div
              className="h-[18px] w-[18px] rounded-[3px]"
              style={{
                background:
                  "linear-gradient(135deg,#3b82f6 0%,#8b5cf6 50%,#ef4444 100%)",
              }}
            />
            <div className="flex items-baseline gap-2">
              <span className="text-slate-200 font-medium text-[13px]">
                Refill Agent
              </span>
              <span className="font-mono text-[10px] text-slate-500 tracking-widest uppercase">
                Use Case A · Voice Inbound · v0.4
              </span>
            </div>
          </div>
          <div className="flex items-center gap-5 font-mono text-[9px] tracking-widest uppercase text-slate-400">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 dot-pulse" />
              session live
            </span>
            <span className="text-slate-500">hmac ttl 600s</span>
            <span className="text-slate-500">phi-redacted log</span>
          </div>
        </header>

        {/* MAIN GRID */}
        <main
          className="grid h-full overflow-hidden"
          style={{ gridTemplateColumns: "260px 1fr 360px" }}
        >
          {/* LEFT — SCENARIOS */}
          <aside
            className="border-r border-slate-800/80 flex flex-col overflow-hidden"
            style={{ background: "#0d121a" }}
          >
            <div className="px-4 pt-4 pb-3">
              <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500">
                Scenarios
              </div>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin px-3 pb-3 space-y-1.5">
              {SCENARIOS.map((s) => {
                const active = s.id === scenarioId;
                const tint = active && s.accentRed;
                return (
                  <button
                    key={s.id}
                    onClick={() => setScenarioId(s.id)}
                    className={[
                      "w-full text-left rounded-[4px] border px-3 py-2.5 transition-colors",
                      active
                        ? tint
                          ? "border-red-500/40 bg-red-500/5"
                          : "border-slate-700 bg-slate-800/50"
                        : "border-slate-800/80 bg-slate-900/30 hover:bg-slate-800/40 hover:border-slate-700/80",
                    ].join(" ")}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[12px] font-medium text-slate-200 leading-tight">
                        {s.title}
                      </div>
                      <span
                        className={[
                          "font-mono text-[8px] tracking-widest uppercase px-1.5 py-0.5 rounded-[2px] border whitespace-nowrap",
                          tint
                            ? "border-red-500/40 text-red-300 bg-red-500/10"
                            : "border-slate-700/70 text-slate-400 bg-slate-900/60",
                        ].join(" ")}
                      >
                        {s.sticker}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500 leading-snug">
                      {s.blurb}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="px-4 py-3 border-t border-slate-800/80">
              <div className="font-mono text-[9px] tracking-widest uppercase text-slate-600">
                Object model
              </div>
              <div className="mt-1.5 font-mono text-[10px] text-slate-500 leading-relaxed">
                Patient__c · Medication__c<br />
                <span className="text-slate-600">1:many · Salesforce backed</span>
              </div>
            </div>
          </aside>

          {/* CENTER — STATE MACHINE */}
          <section
            className="overflow-y-auto scrollbar-thin center-grid"
            style={{ background: "#0a0e14" }}
          >
            <div className="px-6 pt-5 pb-4 flex items-center justify-between">
              <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500">
                State Machine · 8 sequential
              </div>
              <div className="flex items-center gap-3 font-mono text-[9px] tracking-widest uppercase text-slate-500">
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-sm bg-blue-400/70" />
                  deterministic
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-sm bg-amber-400/70" />
                  llm
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-sm bg-red-400/70" />
                  escalation
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-sm bg-emerald-400/70" />
                  complete
                </span>
              </div>
            </div>

            <div className="px-6 space-y-1.5">
              {STATES.map((s, i) => {
                const r = runtime[s.id];
                const status = r.status;
                const cls = statusClasses(status, r.pulseRed);
                const isActive =
                  activeIdx >= 0 &&
                  scenario.steps[activeIdx]?.state === s.id;
                return (
                  <div
                    key={s.id}
                    className={[
                      "border rounded-[4px] px-3 py-2.5 flex items-center gap-3",
                      cls,
                      isActive ? "slide-in" : "",
                    ].join(" ")}
                  >
                    <div className="font-mono text-[10px] text-slate-500 w-6">
                      {String(i + 1).padStart(2, "0")}
                    </div>
                    <div className="font-mono text-[11px] tracking-widest uppercase font-medium w-[150px]">
                      {s.id}
                    </div>
                    <div className="font-mono text-[8px] tracking-widest uppercase text-slate-500 w-[100px]">
                      {s.authority}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400 flex-1 truncate">
                      {r.tool && r.tool !== "—" ? r.tool : ""}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400 w-[60px] text-right">
                      {r.latency ? `${r.latency}ms` : ""}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400 w-[50px] text-right">
                      {r.tokens ? `${r.tokens}t` : ""}
                    </div>
                    <div
                      className={[
                        "font-mono text-[9px] tracking-widest uppercase px-2 py-0.5 rounded-[2px] border w-[100px] text-center",
                        status === "idle"
                          ? "border-slate-700/60 text-slate-600"
                          : status === "escalation"
                            ? "border-red-500/40 text-red-300 bg-red-500/10"
                            : status === "complete"
                              ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                              : status === "llm"
                                ? "border-amber-500/40 text-amber-300 bg-amber-500/10"
                                : "border-blue-500/40 text-blue-300 bg-blue-500/10",
                      ].join(" ")}
                    >
                      {status === "idle"
                        ? "pending"
                        : status === "escalation"
                          ? "ESCALATE"
                          : status === "complete"
                            ? "complete"
                            : status === "llm"
                              ? "running"
                              : "running"}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Hard Rules Ribbon */}
            <div className="px-6 pt-4 pb-6 mt-3">
              <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500 mb-2">
                Hard Rules · always enforced
              </div>
              <div className="flex flex-wrap gap-1.5">
                {RULES.map((r) => (
                  <span
                    key={r}
                    className="font-mono text-[10px] text-slate-400 border border-slate-800/80 bg-slate-900/40 px-2 py-1 rounded-[3px]"
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* RIGHT — PATIENT VIEW / HANDOFF */}
          <aside
            className="border-l border-slate-800/80 overflow-y-auto scrollbar-thin"
            style={{ background: "#0b1018" }}
          >
            {!escalation ? (
              <div className="p-4">
                <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500 mb-3 flex items-center gap-2">
                  <Phone size={10} className="text-slate-500" />
                  Patient View
                </div>
                <div className="space-y-2">
                  {patientLines.length === 0 && (
                    <div className="font-mono text-[10px] text-slate-600 italic">
                      awaiting inbound call…
                    </div>
                  )}
                  {patientLines.map((line, i) => (
                    <div
                      key={i}
                      className="border-l-2 border-slate-700/70 pl-3 py-1 italic text-slate-400 text-[12px] leading-relaxed slide-in"
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <div className="bg-red-500/10 border-b border-red-500/30 px-4 py-3 flex items-center gap-2">
                  <AlertTriangle size={14} className="text-red-300" />
                  <div className="font-mono text-[10px] tracking-widest uppercase text-red-300">
                    EscalationContext received
                  </div>
                </div>

                <div className="p-4 space-y-4">
                  <div>
                    <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500 mb-1.5">
                      Said to patient
                    </div>
                    <div className="border-l-2 border-slate-700/70 pl-3 italic text-slate-400 text-[12px] leading-relaxed">
                      {escalation.safeAck}
                    </div>
                  </div>

                  <div>
                    <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500 mb-1.5">
                      Reason code
                    </div>
                    <span className="inline-block font-mono text-[11px] text-red-300 bg-red-500/10 border border-red-500/40 px-2.5 py-1 rounded-full">
                      {escalation.reason}
                    </span>
                  </div>

                  <div>
                    <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500 mb-1.5">
                      Context payload
                    </div>
                    <JsonBlock data={escalation.payload} />
                  </div>

                  <div>
                    <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500 mb-1.5">
                      Why
                    </div>
                    <div className="border border-slate-800/80 bg-slate-900/40 rounded-[4px] p-3 text-[11px] text-slate-400 leading-relaxed">
                      <span className="text-slate-200">{escalation.ruleCitation}</span>
                    </div>
                  </div>

                  <div>
                    <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500 mb-1.5">
                      Receiving agent
                    </div>
                    <div className="flex items-center gap-3 border border-slate-800/80 rounded-[4px] p-3 bg-slate-900/30">
                      <div className="h-8 w-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center">
                        <User size={14} className="text-slate-400" />
                      </div>
                      <div className="flex-1">
                        <div className="text-[12px] text-slate-200">
                          Specialist · queue 02
                        </div>
                        <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500 mt-0.5">
                          context received · session ownership transferred
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </aside>
        </main>

        {/* FOOTER */}
        <footer
          className="border-t border-slate-800/80 flex items-center px-4 gap-6 relative"
          style={{ background: "#0d121a" }}
        >
          <FooterCell label="STATES" value={`${statesVisited}/8`} />
          <FooterCell label="TOKENS" value={String(tokensTotal)} />
          <FooterCell
            label="LATENCY"
            value={`${latencyTotal}ms`}
            valueClass={latencyRed ? "text-red-400" : "text-slate-200"}
          />
          <button
            onClick={() => setDrawerOpen((v) => !v)}
            className="flex items-center gap-2 ml-auto font-mono text-[10px] tracking-widest uppercase text-slate-400 hover:text-slate-200"
          >
            <Activity size={11} />
            <span className="text-slate-500">AUDIT</span>
            <span className="text-slate-200">{audit.length}</span>
            <span className="text-slate-500">events</span>
            {drawerOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        </footer>

        {/* AUDIT DRAWER */}
        {drawerOpen && (
          <div
            className="absolute left-0 right-0 bottom-[44px] border-t border-slate-800/80 drawer-up z-20"
            style={{ height: "200px", background: "#070a10" }}
          >
            <div className="h-full flex flex-col">
              <div className="px-4 py-2 border-b border-slate-800/80 flex items-center justify-between">
                <div className="font-mono text-[9px] tracking-widest uppercase text-slate-500">
                  Audit Log · per-step trace
                </div>
                <div className="font-mono text-[9px] tracking-widest uppercase text-slate-600">
                  phi-redacted · inputs hashed · session sess_a91c33
                </div>
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                <table className="w-full font-mono text-[10px]">
                  <thead className="sticky top-0" style={{ background: "#070a10" }}>
                    <tr className="text-slate-600 tracking-widest uppercase text-[9px]">
                      <th className="text-left py-1.5 px-4 w-[40px]">#</th>
                      <th className="text-left py-1.5 px-2 w-[140px]">State</th>
                      <th className="text-left py-1.5 px-2 w-[200px]">Tool</th>
                      <th className="text-right py-1.5 px-2 w-[80px]">Latency</th>
                      <th className="text-right py-1.5 px-2 w-[70px]">Tokens</th>
                      <th className="text-left py-1.5 px-2">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((row) => {
                      const isEsc = row.tool === "escalate_to_human";
                      return (
                        <tr
                          key={row.idx}
                          className="border-t border-slate-900/80 hover:bg-slate-900/40"
                        >
                          <td className="py-1 px-4 text-slate-600">
                            {String(row.idx).padStart(2, "0")}
                          </td>
                          <td className="py-1 px-2 text-slate-300">{row.state}</td>
                          <td className="py-1 px-2 text-slate-400">{row.tool}</td>
                          <td className="py-1 px-2 text-right text-slate-400">
                            {row.latency ? `${row.latency}ms` : "—"}
                          </td>
                          <td className="py-1 px-2 text-right text-slate-400">
                            {row.tokens ?? "—"}
                          </td>
                          <td
                            className={
                              "py-1 px-2 " +
                              (isEsc ? "text-red-300" : "text-slate-400")
                            }
                          >
                            {row.outcome}
                          </td>
                        </tr>
                      );
                    })}
                    {audit.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-600">
                          no events yet
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

function FooterCell({
  label,
  value,
  valueClass = "text-slate-200",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center gap-2 font-mono text-[10px] tracking-widest uppercase">
      <span className="text-slate-500">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

export default Index;
