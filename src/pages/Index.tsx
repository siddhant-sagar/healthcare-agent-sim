import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Activity,
  ChevronUp,
  ChevronDown,
  Phone,
  ShieldCheck,
  CheckCircle2,
  User,
  Sparkles,
  Cpu,
  Zap,
  ArrowRight,
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

type StateId =
  | "IDENTIFY"
  | "VERIFY_DOB"
  | "FETCH_MEDS"
  | "SELECT_MED"
  | "VALIDATE_MED"
  | "CONFIRM_PHARMACY"
  | "CREATE_REFILL"
  | "COMPLETE";

type Step = {
  state: StateId | "ESCALATE";
  tool: string;
  patientLine?: string;
  latency: number;
  tokens: number;
  outcome: string;
  escalate?: {
    reason: ReasonCode;
    payload: Record<string, unknown>;
    ruleCitation: string;
    safeAck: string;
  };
  pulseRed?: boolean;
};

type Scenario = {
  id: string;
  title: string;
  sticker: string;
  blurb: string;
  accentRed?: boolean;
  steps: Step[];
};

const STATES: { id: StateId; authority: Authority; label: string }[] = [
  { id: "IDENTIFY",         authority: "DETERMINISTIC", label: "Identify" },
  { id: "VERIFY_DOB",       authority: "DETERMINISTIC", label: "Verify DOB" },
  { id: "FETCH_MEDS",       authority: "DETERMINISTIC", label: "Fetch meds" },
  { id: "SELECT_MED",       authority: "LLM",           label: "Select med" },
  { id: "VALIDATE_MED",     authority: "DETERMINISTIC", label: "Validate" },
  { id: "CONFIRM_PHARMACY", authority: "LLM",           label: "Confirm pharmacy" },
  { id: "CREATE_REFILL",    authority: "DETERMINISTIC", label: "Create refill" },
  { id: "COMPLETE",         authority: "—",             label: "Complete" },
];

/* ------------------------------------------------------------------ */
/*  Mock metric helpers                                                */
/* ------------------------------------------------------------------ */

const detTok = () => 40 + Math.floor(Math.random() * 60);
const llmTok = () => 180 + Math.floor(Math.random() * 120);
const llmLat = () => 380 + Math.floor(Math.random() * 80);

/* ------------------------------------------------------------------ */
/*  Scenarios (unchanged data)                                         */
/* ------------------------------------------------------------------ */

const SCENARIOS: Scenario[] = [
  {
    id: "happy",
    title: "Happy path refill",
    sticker: "BASELINE",
    blurb: "All 8 states fire and complete cleanly.",
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
    blurb: "Controlled flag detected pre-LLM → SELECT_MED bypassed, escalate.",
    accentRed: true,
    steps: [
      { state: "IDENTIFY", tool: "get_patient_by_phone", latency: 207, tokens: detTok(),
        outcome: "200 OK · pid=p_55021",
        patientLine: "Hi, this is the refill line. I have your number on file." },
      { state: "VERIFY_DOB", tool: "validate_dob", latency: 122, tokens: detTok(),
        outcome: "match · token issued",
        patientLine: "Could you verify your date of birth, please?" },
      { state: "FETCH_MEDS", tool: "SOQL Medication__c", latency: 311, tokens: detTok(),
        outcome: "2 rows · 1 flagged Controlled__c=true",
        patientLine: "One moment while I pull up your medications." },
      { state: "SELECT_MED", tool: "—", latency: 0, tokens: 0,
        outcome: "BYPASSED · controlled flag detected pre-LLM",
        pulseRed: true },
      { state: "VALIDATE_MED", tool: "—", latency: 91, tokens: detTok(),
        outcome: "Controlled=true → ESCALATE",
        pulseRed: true,
        escalate: {
          reason: "controlled_medication",
          payload: { patient_id: "p_55021", medication_id: "m_771", timestamp: "2026-04-27T13:31:08Z" },
          ruleCitation: "R2 · Controlled__c=true escalates BEFORE Active__c check and BEFORE any LLM output.",
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
          payload: { patient_id: "p_30188", attempt_count: 2, timestamp: "2026-04-27T13:31:08Z" },
          ruleCitation: "R1 · DOB must be verified before any medication field, name, or count is disclosed.",
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
          safeAck: "Let me connect you with a team member who can assist you directly.",
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
          ruleCitation: "R3 · Active__c=false → block refill, escalate to a human.",
          safeAck: "Let me connect you with a team member who can assist you directly.",
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
          ruleCitation: "R7 · POST /refills must return 2xx; ≥2 failures → api_failure escalation.",
          safeAck: "I encountered an issue submitting your request. Connecting you to complete this.",
        } },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Visual helpers — light theme, semantic tokens                      */
/* ------------------------------------------------------------------ */

const authorityToStatus = (a: Authority): Status =>
  a === "LLM" ? "llm" : a === "DETERMINISTIC" ? "deterministic" : "complete";

function stateChrome(status: Status, pulseRed = false) {
  if (pulseRed) {
    return {
      card: "bg-destructive/5 border-destructive/40 pulse-ring",
      dot:  "bg-destructive",
      pill: "bg-destructive text-destructive-foreground",
      text: "text-destructive",
    };
  }
  switch (status) {
    case "deterministic":
      return {
        card: "bg-info/5 border-info/30",
        dot:  "bg-info",
        pill: "bg-info/10 text-info border border-info/30",
        text: "text-info",
      };
    case "llm":
      return {
        card: "bg-warning/10 border-warning/40",
        dot:  "bg-warning",
        pill: "bg-warning/15 text-warning-foreground border border-warning/40",
        text: "text-foreground",
      };
    case "escalation":
      return {
        card: "bg-destructive/5 border-destructive/40",
        dot:  "bg-destructive",
        pill: "bg-destructive text-destructive-foreground",
        text: "text-destructive",
      };
    case "complete":
      return {
        card: "bg-success/5 border-success/30",
        dot:  "bg-success",
        pill: "bg-success/10 text-success border border-success/30",
        text: "text-success",
      };
    default:
      return {
        card: "bg-card border-border",
        dot:  "bg-muted-foreground/40",
        pill: "bg-muted text-muted-foreground border border-border",
        text: "text-muted-foreground",
      };
  }
}

/* ------------------------------------------------------------------ */
/*  JSON renderer                                                      */
/* ------------------------------------------------------------------ */

function JsonBlock({ data }: { data: unknown }) {
  const lines = JSON.stringify(data, null, 2).split("\n");
  return (
    <pre className="font-mono text-[11px] leading-[1.6] bg-foreground/[0.03] border border-border rounded-md p-3 overflow-x-auto">
      {lines.map((line, i) => (
        <div key={i}>{colorize(line)}</div>
      ))}
    </pre>
  );
}

function colorize(line: string) {
  const m = line.match(/^(\s*)("?)([^":]+?)("?)(\s*:\s*)(.*)$/);
  if (!m || !line.includes(":")) {
    return <span className="text-muted-foreground">{line}</span>;
  }
  const [, indent, q1, key, q2, colon, rest] = m;
  return (
    <>
      <span className="text-muted-foreground">{indent}</span>
      <span className="text-info">{q1}{key}{q2}</span>
      <span className="text-muted-foreground">{colon}</span>
      {colorizeValue(rest)}
    </>
  );
}

function colorizeValue(v: string) {
  const trailing = v.endsWith(",") ? "," : "";
  const body = trailing ? v.slice(0, -1) : v;
  if (/^".*"$/.test(body))
    return (<><span className="text-success">{body}</span><span className="text-muted-foreground">{trailing}</span></>);
  if (/^-?\d+(\.\d+)?$/.test(body))
    return (<><span className="text-primary">{body}</span><span className="text-muted-foreground">{trailing}</span></>);
  if (/^\[.*\]$/.test(body))
    return (<><span className="text-primary">{body}</span><span className="text-muted-foreground">{trailing}</span></>);
  return (<><span className="text-foreground">{body}</span><span className="text-muted-foreground">{trailing}</span></>);
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
  outcome?: string;
  pulseRed?: boolean;
};

const RULES = [
  { code: "R1", text: "DOB before disclosure" },
  { code: "R2", text: "Controlled → escalate" },
  { code: "R3", text: "Inactive → block" },
  { code: "R4", text: "2-retry cap" },
  { code: "R6", text: "10-transition cap" },
  { code: "R7", text: "API ≥2 failures → escalate" },
];

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

  useEffect(() => {
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
        setRuntime((prev) => {
          const next = { ...prev };
          (Object.keys(next) as StateId[]).forEach((k) => {
            if (next[k].status === "deterministic" || next[k].status === "llm") {
              if (k !== step.state) next[k] = { ...next[k], status: "complete" };
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
              outcome: step.outcome,
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

        if (step.patientLine) setPatientLines((prev) => [...prev, step.patientLine!]);
        setTokensTotal((p) => p + step.tokens);
        setLatencyTotal((p) => p + step.latency);
        setAudit((prev) => [
          ...prev,
          { idx: prev.length + 1, state: step.state, tool: step.tool, latency: step.latency || null, tokens: step.tokens || null, outcome: step.outcome },
        ]);

        if (step.escalate) {
          setAudit((prev) => [
            ...prev,
            { idx: prev.length + 1, state: "—", tool: "escalate_to_human", latency: null, tokens: null, outcome: step.escalate!.reason.toUpperCase() },
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
    <div className="min-h-screen bg-warm-wash text-foreground">
      {/* ============================ HEADER ============================ */}
      <header className="sticky top-0 z-30 backdrop-blur-md bg-background/60 border-b border-border/60">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shadow-card shrink-0">
              <Sparkles size={18} strokeWidth={2.4} />
            </div>
            <div className="min-w-0">
              <div className="font-display font-bold text-[15px] sm:text-base text-foreground leading-tight truncate">
                Refill Agent
              </div>
              <div className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider text-muted-foreground truncate">
                Voice Inbound · Use Case A · v0.4
              </div>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-success dot-pulse" />
              session live
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={12} className="text-success" />
              PHI-redacted
            </span>
            <span>HMAC TTL 600s</span>
          </div>
          <a
            href="#scenarios"
            className="hidden sm:inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground hover:bg-primary-hover transition-colors px-4 py-2 text-sm font-medium shadow-card"
          >
            Try a scenario
            <ArrowRight size={14} />
          </a>
        </div>
      </header>

      {/* ============================ HERO ============================ */}
      <section className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 pt-8 sm:pt-12 lg:pt-16 pb-6">
        <div className="grid lg:grid-cols-[1.2fr_1fr] gap-8 lg:gap-12 items-end">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-card/70 backdrop-blur border border-border px-3 py-1 text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-5">
              <Cpu size={11} className="text-primary" />
              Healthcare AI · Voice agent simulator
            </div>
            <h1 className="font-display font-bold text-[40px] sm:text-[56px] lg:text-[68px] leading-[1.02] tracking-tight text-foreground">
              Deterministic where it must be.
              <br />
              <span className="text-primary">Smart where it can be.</span>
            </h1>
            <p className="mt-5 text-base sm:text-lg text-muted-foreground max-w-2xl leading-relaxed">
              An inbound voice agent for medication refills. Watch six real scenarios fire through an
              8-state machine — Salesforce-backed, scoped LLM, audited escalations.
            </p>
          </div>
          <div className="hidden lg:flex flex-col gap-3 text-sm">
            <HeroStat label="Hard rules enforced" value="6" sub="R1 – R7" />
            <HeroStat label="States visible" value="8 / 8" sub="no pagination, no hiding" />
            <HeroStat label="Escalation reasons" value="7" sub="every failure has a code" />
          </div>
        </div>
      </section>

      {/* ============================ MAIN GRID ============================ */}
      <main
        id="scenarios"
        className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 pb-32"
      >
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr_360px] gap-4 lg:gap-6">
          {/* ============== LEFT — SCENARIOS ============== */}
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <div className="rounded-2xl bg-card border border-border shadow-card overflow-hidden">
              <div className="px-5 py-4 border-b border-border">
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Scenarios
                </div>
                <div className="font-display font-semibold text-foreground text-base mt-1">
                  Pick one · auto-plays
                </div>
              </div>

              {/* Mobile: horizontal scroll. Desktop: stacked. */}
              <div className="lg:hidden flex gap-2 overflow-x-auto p-3 scrollbar-thin">
                {SCENARIOS.map((s) => (
                  <ScenarioPill
                    key={s.id}
                    scenario={s}
                    active={s.id === scenarioId}
                    onClick={() => setScenarioId(s.id)}
                  />
                ))}
              </div>

              <div className="hidden lg:flex flex-col gap-2 p-3">
                {SCENARIOS.map((s) => (
                  <ScenarioCard
                    key={s.id}
                    scenario={s}
                    active={s.id === scenarioId}
                    onClick={() => setScenarioId(s.id)}
                  />
                ))}
              </div>

              <div className="px-5 py-4 border-t border-border bg-secondary/40">
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Object model
                </div>
                <div className="mt-1 font-mono text-[11px] text-foreground/80 leading-relaxed">
                  Patient__c · Medication__c
                  <div className="text-muted-foreground mt-0.5">1:many · Salesforce backed</div>
                </div>
              </div>
            </div>
          </aside>

          {/* ============== CENTER — STATE MACHINE ============== */}
          <section className="rounded-2xl bg-card border border-border shadow-card-lg overflow-hidden">
            <div className="px-5 sm:px-6 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  State machine
                </div>
                <div className="font-display font-semibold text-foreground text-base mt-1">
                  {scenario.title}
                </div>
              </div>
              <div className="flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                <Legend dot="bg-info" label="deterministic" />
                <Legend dot="bg-warning" label="llm" />
                <Legend dot="bg-success" label="complete" />
                <Legend dot="bg-destructive" label="escalation" />
              </div>
            </div>

            <div className="p-3 sm:p-4 space-y-2">
              {STATES.map((s, i) => {
                const r = runtime[s.id];
                const chrome = stateChrome(r.status, r.pulseRed);
                const isActive =
                  activeIdx >= 0 && scenario.steps[activeIdx]?.state === s.id;
                const isLLM = s.authority === "LLM";
                return (
                  <div
                    key={s.id}
                    className={[
                      "relative border rounded-xl px-3 sm:px-4 py-3 transition-all duration-300",
                      chrome.card,
                      isActive ? "slide-in shadow-card" : "",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-3 sm:gap-4">
                      {/* number + dot */}
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-[10px] text-muted-foreground w-5 text-right">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className={["h-2 w-2 rounded-full", chrome.dot].join(" ")} />
                      </div>

                      {/* label */}
                      <div className="min-w-0 flex-1">
                        <div
                          className={[
                            "font-display font-semibold text-foreground text-[14px] truncate",
                            r.outcome?.startsWith("BYPASSED") ? "line-through opacity-60" : "",
                          ].join(" ")}
                        >
                          {s.label}
                        </div>
                        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground truncate">
                          {s.id} · {isLLM ? (
                            <span className="text-warning-foreground">scoped LLM</span>
                          ) : s.authority === "DETERMINISTIC" ? (
                            <span className="text-info">deterministic</span>
                          ) : (
                            "—"
                          )}
                        </div>
                      </div>

                      {/* tool / metrics */}
                      <div className="hidden sm:flex flex-col items-end shrink-0 min-w-[110px]">
                        <div className="font-mono text-[11px] text-foreground/70 truncate max-w-[180px]">
                          {r.tool && r.tool !== "—" ? r.tool : ""}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {r.latency ? `${r.latency}ms` : ""} {r.tokens ? `· ${r.tokens}t` : ""}
                        </div>
                      </div>

                      {/* status pill */}
                      <span
                        className={[
                          "font-mono text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full shrink-0 min-w-[88px] text-center",
                          r.status === "idle"
                            ? "bg-muted text-muted-foreground border border-border"
                            : chrome.pill,
                        ].join(" ")}
                      >
                        {r.status === "idle"
                          ? "pending"
                          : r.outcome?.startsWith("BYPASSED")
                            ? "BYPASSED"
                            : r.status === "escalation"
                              ? "ESCALATE"
                              : r.status === "complete"
                                ? "complete"
                                : "running"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Hard Rules Ribbon */}
            <div className="px-5 sm:px-6 pt-2 pb-5 border-t border-border bg-secondary/30">
              <div className="flex items-center gap-2 mb-3 mt-3">
                <ShieldCheck size={14} className="text-primary" />
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Hard rules · always enforced
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {RULES.map((r) => (
                  <span
                    key={r.code}
                    className="inline-flex items-center gap-1.5 font-mono text-[11px] text-foreground/80 bg-card border border-border px-2.5 py-1 rounded-full shadow-card"
                  >
                    <span className="text-primary font-semibold">{r.code}</span>
                    <span className="text-muted-foreground">·</span>
                    <span>{r.text}</span>
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* ============== RIGHT — PATIENT / HANDOFF ============== */}
          <aside className="rounded-2xl bg-card border border-border shadow-card overflow-hidden">
            {!escalation ? (
              <div>
                <div className="px-5 py-4 border-b border-border bg-secondary/40">
                  <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    <Phone size={11} className="text-success" />
                    Patient view · what they hear
                  </div>
                  <div className="font-display font-semibold text-foreground text-base mt-1">
                    Live transcript
                  </div>
                </div>
                <div className="p-5 space-y-3 min-h-[280px] max-h-[520px] overflow-y-auto scrollbar-thin">
                  {patientLines.length === 0 && (
                    <div className="font-mono text-[11px] text-muted-foreground italic flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 dot-pulse" />
                      awaiting inbound call…
                    </div>
                  )}
                  {patientLines.map((line, i) => (
                    <div
                      key={i}
                      className="rounded-xl bg-secondary/60 border border-border px-4 py-3 slide-in"
                    >
                      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                        Agent
                      </div>
                      <div className="text-[14px] text-foreground leading-relaxed">
                        “{line}”
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="slide-in">
                <div className="px-5 py-4 border-b border-destructive/30 bg-destructive/5 flex items-center gap-2">
                  <AlertTriangle size={14} className="text-destructive" />
                  <div className="font-mono text-[10px] uppercase tracking-widest text-destructive">
                    Escalation context received
                  </div>
                </div>

                <div className="p-5 space-y-5">
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                      Said to patient
                    </div>
                    <div className="rounded-xl bg-secondary/60 border border-border px-4 py-3 text-[14px] text-foreground leading-relaxed">
                      “{escalation.safeAck}”
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                      Reason code
                    </div>
                    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] bg-destructive text-destructive-foreground px-3 py-1.5 rounded-full font-semibold uppercase tracking-wider">
                      <AlertTriangle size={11} />
                      {escalation.reason}
                    </span>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                      Context payload
                    </div>
                    <JsonBlock data={escalation.payload} />
                  </div>

                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                      Why
                    </div>
                    <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-[12px] text-foreground leading-relaxed">
                      <span className="font-semibold text-primary">{escalation.ruleCitation.split(" · ")[0]}</span>
                      <span className="text-muted-foreground"> · </span>
                      {escalation.ruleCitation.split(" · ").slice(1).join(" · ")}
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                      Receiving agent
                    </div>
                    <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 p-3">
                      <div className="h-9 w-9 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
                        <User size={15} className="text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-foreground font-medium">
                          Specialist · queue 02
                        </div>
                        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5 truncate">
                          context received · ownership transferred
                        </div>
                      </div>
                      <CheckCircle2 size={16} className="text-success shrink-0" />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>

        {/* ============== METRICS / RAILS ============== */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <MetricCard label="States visited" value={`${statesVisited}/8`} icon={<Activity size={14} />} />
          <MetricCard label="Tokens" value={String(tokensTotal)} icon={<Cpu size={14} />} />
          <MetricCard
            label="Cumulative latency"
            value={`${latencyTotal}ms`}
            valueClass={latencyRed ? "text-destructive" : "text-foreground"}
            icon={<Zap size={14} className={latencyRed ? "text-destructive" : "text-primary"} />}
          />
          <MetricCard label="Audit events" value={String(audit.length)} icon={<ShieldCheck size={14} />} />
        </div>

        {/* ============== AUDIT TOGGLE ============== */}
        <button
          onClick={() => setDrawerOpen((v) => !v)}
          className="mt-4 w-full rounded-2xl bg-card border border-border shadow-card hover:shadow-card-lg transition-shadow px-5 py-4 flex items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-foreground text-background flex items-center justify-center shrink-0">
              <Activity size={16} />
            </div>
            <div className="text-left min-w-0">
              <div className="font-display font-semibold text-foreground text-[14px]">
                Audit log
              </div>
              <div className="font-mono text-[11px] text-muted-foreground truncate">
                {audit.length} events · PHI-redacted · session sess_a91c33
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground text-[12px] font-mono uppercase tracking-wider shrink-0">
            {drawerOpen ? "Hide" : "Show"}
            {drawerOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </div>
        </button>

        {drawerOpen && (
          <div className="mt-3 rounded-2xl bg-card border border-border shadow-card overflow-hidden drawer-up">
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[11px] min-w-[640px]">
                <thead className="bg-secondary/60">
                  <tr className="text-muted-foreground uppercase tracking-wider text-[10px]">
                    <th className="text-left py-2.5 px-4 w-[40px]">#</th>
                    <th className="text-left py-2.5 px-2 w-[140px]">State</th>
                    <th className="text-left py-2.5 px-2 w-[180px]">Tool</th>
                    <th className="text-right py-2.5 px-2 w-[80px]">Latency</th>
                    <th className="text-right py-2.5 px-2 w-[70px]">Tokens</th>
                    <th className="text-left py-2.5 px-2">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((row) => {
                    const isEsc = row.tool === "escalate_to_human";
                    return (
                      <tr key={row.idx} className="border-t border-border hover:bg-secondary/30">
                        <td className="py-2 px-4 text-muted-foreground">{String(row.idx).padStart(2, "0")}</td>
                        <td className="py-2 px-2 text-foreground">{row.state}</td>
                        <td className="py-2 px-2 text-foreground/80">{row.tool}</td>
                        <td className="py-2 px-2 text-right text-foreground/80">{row.latency ? `${row.latency}ms` : "—"}</td>
                        <td className="py-2 px-2 text-right text-foreground/80">{row.tokens ?? "—"}</td>
                        <td className={"py-2 px-2 " + (isEsc ? "text-destructive font-semibold" : "text-foreground/80")}>
                          {row.outcome}
                        </td>
                      </tr>
                    );
                  })}
                  {audit.length === 0 && (
                    <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">no events yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-border/60 bg-background/40 backdrop-blur">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6 text-[12px] text-muted-foreground flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            Portfolio piece · Senior PM, Healthcare AI · 2026
          </div>
          <div className="font-mono text-[11px] uppercase tracking-wider">
            Built for the 90-second read · light · audited · scoped LLM
          </div>
        </div>
      </footer>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function HeroStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl bg-card/80 backdrop-blur border border-border shadow-card px-5 py-4">
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="font-display font-bold text-3xl text-foreground mt-1">{value}</div>
      <div className="font-mono text-[11px] text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function ScenarioCard({
  scenario, active, onClick,
}: { scenario: Scenario; active: boolean; onClick: () => void }) {
  const danger = scenario.accentRed;
  return (
    <button
      onClick={onClick}
      className={[
        "w-full text-left rounded-xl border px-4 py-3 transition-all",
        active
          ? danger
            ? "border-destructive/40 bg-destructive/5 shadow-card"
            : "border-primary/40 bg-primary/5 shadow-card"
          : "border-border bg-card hover:border-foreground/20 hover:bg-secondary/40",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-display font-semibold text-[13px] text-foreground leading-tight">
          {scenario.title}
        </div>
        <span
          className={[
            "font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-full whitespace-nowrap shrink-0",
            danger
              ? "bg-destructive/10 text-destructive border border-destructive/30"
              : active
                ? "bg-primary/10 text-primary border border-primary/30"
                : "bg-secondary text-muted-foreground border border-border",
          ].join(" ")}
        >
          {scenario.sticker}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground leading-snug">
        {scenario.blurb}
      </div>
    </button>
  );
}

function ScenarioPill({
  scenario, active, onClick,
}: { scenario: Scenario; active: boolean; onClick: () => void }) {
  const danger = scenario.accentRed;
  return (
    <button
      onClick={onClick}
      className={[
        "shrink-0 rounded-full border px-3.5 py-2 text-[12px] font-medium transition-all whitespace-nowrap",
        active
          ? danger
            ? "border-destructive bg-destructive text-destructive-foreground"
            : "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-foreground hover:border-foreground/30",
      ].join(" ")}
    >
      {scenario.title}
    </button>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={["h-2 w-2 rounded-full", dot].join(" ")} />
      {label}
    </span>
  );
}

function MetricCard({
  label, value, valueClass = "text-foreground", icon,
}: { label: string; value: string; valueClass?: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-card border border-border shadow-card p-4">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-[10px] font-mono uppercase tracking-widest">{label}</span>
        <span className="text-primary">{icon}</span>
      </div>
      <div className={["font-display font-bold text-2xl mt-1.5", valueClass].join(" ")}>
        {value}
      </div>
    </div>
  );
}

export default Index;
