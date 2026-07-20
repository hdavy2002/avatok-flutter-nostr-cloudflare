// worker/src/lib/tool_runtime.ts
//
// AVA-CAMP-C-TOOLRT — generic mid-call ToolRuntime for the campaign AI agent.
// Spec: Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §8 (AI conversation runtime —
// ToolRuntime rules) and §19 seams 1 & 6.
//
// Provider-agnostic: no Env / DurableObject imports. The owning room (e.g.
// VobizAgentRoom, campaign mode) builds the ToolDef[] (composio calendar
// tools, system tools, local tools), constructs `new ToolRuntime(tools)`,
// feeds `declarations()` into the Gemini Live `setup.tools` payload as
// `functionDeclarations`, and on `msg.toolCall` calls `invoke(name, args)`
// per functionCall, then sends the ToolResult(s) back as
// `sendGem({ toolResponse: { functionResponses: [...] } })`. This module
// owns none of that Gemini plumbing — only the runtime loop.
//
// Rules enforced here (§8):
//   - tool declarations FROZEN at construction (session creation)
//   - single in-flight tool call, FIFO queue for the rest
//   - structured {success, error_code, elapsed_ms, ...} responses
//   - 8s per-call timeout -> error_code 'tool_timeout'
//   - 3-failure circuit breaker -> tools disabled for the rest of the call
//   - tool budget: 6 total / 2 availability / 2 booking per call
//
// NOTE: per §10/§19 seam 1, a "handover" system tool (transfer_to_human) does
// NOT draw from this budget — that is enforced by the room giving handover
// its own 1-per-call counter outside ToolRuntime, not by anything in here.
// If a caller registers a handover-like tool through ToolRuntime anyway, it
// will be budgeted like any other tool — callers that want the seam-1
// exemption must keep that tool's invocation off this class entirely.

/** A single tool the agent may call mid-conversation. */
export interface ToolDef {
  /** Function name as declared to the model; must be unique within a runtime. */
  name: string;
  /** Natural-language description shown to the model. */
  description: string;
  /** JSON Schema (Gemini-flavored OBJECT/STRING/... typing) for the function args. */
  parameters: Record<string, unknown>;
  /** Execution family — informational for callers/telemetry; ToolRuntime treats all kinds alike. */
  kind: "composio" | "system" | "local";
  /** Which budget bucket this tool draws from. */
  budgetClass: "availability" | "booking" | "system" | "general";
  /** The actual implementation. Must resolve, not throw, when possible — thrown errors are caught and normalized. */
  handler: (args: any) => Promise<ToolResult>;
}

/** Structured result every tool call must produce (or that ToolRuntime synthesizes on failure). */
export interface ToolResult {
  success: boolean;
  error_code?: string;
  [k: string]: unknown;
}

/** One row of the mid-call tool audit trail — persisted to campaign_call_attempts.tools_used. */
export interface ToolCallLogEntry {
  name: string;
  success: boolean;
  error_code?: string;
  elapsed_ms: number;
  ts: number;
}

/** Gemini Live functionDeclarations entry shape. */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolRuntimeOptions {
  /** Total tool-call budget per call. Default 6. */
  totalBudget?: number;
  /** Budget for tools with budgetClass 'availability'. Default 2. */
  availabilityBudget?: number;
  /** Budget for tools with budgetClass 'booking'. Default 2. */
  bookingBudget?: number;
  /** Per-invocation timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Consecutive-failure count that trips the circuit breaker. Default 3. */
  failureBreaker?: number;
}

interface Budgets {
  total: number;
  availability: number;
  booking: number;
}

const DEFAULTS: Required<ToolRuntimeOptions> = {
  totalBudget: 6,
  availabilityBudget: 2,
  bookingBudget: 2,
  timeoutMs: 8000,
  failureBreaker: 3,
};

/**
 * Generic mid-call tool loop for the campaign AI agent's Gemini Live session.
 * One instance per call. Provider-agnostic — the owning room supplies the
 * Gemini functionCall <-> ToolRuntime.invoke() <-> functionResponse plumbing.
 */
export class ToolRuntime {
  private readonly tools: ReadonlyMap<string, ToolDef>;
  private readonly frozenDeclarations: GeminiFunctionDeclaration[];
  private readonly opts: Required<ToolRuntimeOptions>;

  private readonly log: ToolCallLogEntry[] = [];

  private usedTotal = 0;
  private usedAvailability = 0;
  private usedBooking = 0;

  private consecutiveFailures = 0;
  private breakerTripped = false;

  // FIFO single-in-flight mutex: chain of promises, each invoke() call
  // appends itself to the tail and awaits its predecessor before running.
  private queueTail: Promise<void> = Promise.resolve();

  constructor(tools: ToolDef[], opts?: ToolRuntimeOptions) {
    this.opts = { ...DEFAULTS, ...(opts ?? {}) };

    const map = new Map<string, ToolDef>();
    for (const t of tools) {
      map.set(t.name, t);
    }
    this.tools = map;

    // Frozen at construction (session creation) per §8 — declarations() only
    // ever returns copies of this snapshot, regardless of later mutation.
    this.frozenDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** Gemini functionDeclarations array, frozen at construction. Always returns a fresh copy. */
  declarations(): GeminiFunctionDeclaration[] {
    return this.frozenDeclarations.map((d) => ({ ...d }));
  }

  /** True once the circuit breaker has tripped (failureBreaker consecutive failures). */
  disabled(): boolean {
    return this.breakerTripped;
  }

  /** Audit trail of every tool call attempted this session, in call order. */
  getLog(): ToolCallLogEntry[] {
    return this.log.slice();
  }

  /** Remaining budget per bucket, for the prompt/agent to know when to wrap up. */
  remainingBudget(): Budgets {
    return {
      total: Math.max(0, this.opts.totalBudget - this.usedTotal),
      availability: Math.max(0, this.opts.availabilityBudget - this.usedAvailability),
      booking: Math.max(0, this.opts.bookingBudget - this.usedBooking),
    };
  }

  /**
   * Invoke a tool by name. Enforces single-in-flight (FIFO queue), budget,
   * circuit breaker, and timeout. Always resolves (never throws) with a
   * structured ToolResult, and always appends exactly one ToolCallLogEntry.
   */
  async invoke(name: string, args: any): Promise<ToolResult> {
    // Chain onto the FIFO queue: wait for whoever is ahead of us (in-flight
    // call + everyone already queued), then run, then release the next.
    let release!: () => void;
    const myTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previousTail = this.queueTail;
    this.queueTail = this.queueTail.then(() => myTurn);

    await previousTail;
    try {
      return await this.runOne(name, args);
    } finally {
      release();
    }
  }

  // Runs a single tool call to completion. Called only while holding the
  // FIFO "turn" — i.e. never concurrently with another runOne().
  private async runOne(name: string, args: any): Promise<ToolResult> {
    const ts = Date.now();

    // Circuit breaker check happens before anything else consumes budget.
    if (this.breakerTripped) {
      return this.finish(name, ts, { success: false, error_code: "tools_disabled" });
    }

    const def = this.tools.get(name);
    if (!def) {
      return this.finish(name, ts, { success: false, error_code: "unknown_tool" });
    }

    if (!this.hasBudget(def.budgetClass)) {
      return this.finish(name, ts, { success: false, error_code: "budget_exhausted" });
    }

    // Reserve budget for this attempt (attempted invocations count, per §8).
    this.consumeBudget(def.budgetClass);

    const timeoutMs = this.opts.timeoutMs;
    const TIMEOUT = Symbol("tool_timeout");

    let result: ToolResult;
    try {
      const raced = await Promise.race([
        def.handler(args).catch(
          (e): ToolResult => ({
            success: false,
            error_code: "tool_error",
            message: e instanceof Error ? e.message : String(e),
          }),
        ),
        new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), timeoutMs)),
      ]);

      if (raced === TIMEOUT) {
        result = { success: false, error_code: "tool_timeout" };
      } else {
        result = raced as ToolResult;
      }
    } catch (e) {
      // Defensive: handler + race machinery should not throw, but never let
      // an uncaught rejection escape invoke().
      result = {
        success: false,
        error_code: "tool_error",
        message: e instanceof Error ? e.message : String(e),
      };
    }

    if (result.success) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.opts.failureBreaker) {
        this.breakerTripped = true;
      }
    }

    return this.finish(name, ts, result);
  }

  private finish(name: string, ts: number, result: ToolResult): ToolResult {
    this.log.push({
      name,
      success: result.success,
      error_code: result.error_code,
      elapsed_ms: Date.now() - ts,
      ts,
    });
    return result;
  }

  private hasBudget(budgetClass: ToolDef["budgetClass"]): boolean {
    if (this.usedTotal >= this.opts.totalBudget) return false;
    if (budgetClass === "availability" && this.usedAvailability >= this.opts.availabilityBudget) {
      return false;
    }
    if (budgetClass === "booking" && this.usedBooking >= this.opts.bookingBudget) {
      return false;
    }
    return true;
  }

  private consumeBudget(budgetClass: ToolDef["budgetClass"]): void {
    this.usedTotal += 1;
    if (budgetClass === "availability") this.usedAvailability += 1;
    if (budgetClass === "booking") this.usedBooking += 1;
  }
}
