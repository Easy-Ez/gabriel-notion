import { NotionError, isNotionError } from "../errors.js";
import { Emitter } from "../util/emitter.js";
import { Singleflight } from "../util/async.js";
import type { Logger } from "../util/logger.js";

export type SessionState = "VALID" | "CHECKING" | "AUTH_DEAD";

/** Why the session was re-checked. */
export type SessionCheckTrigger = "http_401" | "missing_record" | "manual";

export interface SessionEvents extends Record<string, unknown> {
  "auth.dead": { trigger: SessionCheckTrigger; at: string };
}

export interface SessionHealth {
  state: SessionState;
  lastCheckAt?: string;
  lastCheckTrigger?: SessionCheckTrigger;
}

/**
 * Outcome of the validation call:
 * - "valid": the session works (HTTP 200)
 * - "dead": the server rejected the session (HTTP 401)
 * Transport failures are thrown, not returned: they say nothing about the session.
 */
export type ValidationResult = "valid" | "dead";

/**
 * Session state machine (spec §3):
 *
 *   VALID → CHECKING  on HTTP 401, or a read that returned 200 without its record
 *   CHECKING → VALID     validation (authValidate) returned 200
 *   CHECKING → AUTH_DEAD validation returned 401; terminal, emits `auth.dead` once
 *
 * Concurrent triggers share one validation call (singleflight). AUTH_DEAD is terminal on
 * purpose: retrying a dead session only produces noise, and re-login needs a person.
 */
export class Session {
  readonly events = new Emitter<SessionEvents>();
  private state: SessionState = "VALID";
  private lastCheckAt?: number;
  private lastCheckTrigger?: SessionCheckTrigger;
  private readonly flight = new Singleflight<SessionState>();
  private validator?: () => Promise<ValidationResult>;

  constructor(private readonly logger: Logger, private readonly now: () => number = Date.now) {}

  /** Wires the call that validates the session (set by the HTTP client). */
  setValidator(fn: () => Promise<ValidationResult>): void {
    this.validator = fn;
  }

  current(): SessionState {
    return this.state;
  }

  /** Throws AUTH_DEAD when the session is known to be dead. */
  assertUsable(): void {
    if (this.state === "AUTH_DEAD") {
      throw new NotionError("AUTH_DEAD", "the Notion session is signed out or expired; sign in again with signInWithBrowser()");
    }
  }

  /**
   * Re-validates the session. Resolves to the resulting state; never resolves to CHECKING.
   * A transport failure during validation leaves the state unchanged and rethrows.
   */
  confirm(trigger: SessionCheckTrigger): Promise<SessionState> {
    if (this.state === "AUTH_DEAD") return Promise.resolve("AUTH_DEAD");
    return this.flight.do("confirm", async () => {
      const validator = this.validator;
      if (!validator) throw new NotionError("INVALID_STATE", "session validator is not configured");
      const previous = this.state;
      this.state = "CHECKING";
      this.lastCheckTrigger = trigger;
      try {
        const result = await validator();
        this.lastCheckAt = this.now();
        if (result === "valid") {
          this.state = "VALID";
          this.logger.info({ trigger }, "session check passed");
          return "VALID";
        }
        this.state = "AUTH_DEAD";
        this.logger.error({ trigger }, "session is dead");
        this.events.emit("auth.dead", { trigger, at: new Date(this.lastCheckAt).toISOString() }, (err) =>
          this.logger.error({ err: isNotionError(err) ? err.code : String(err) }, "auth.dead listener threw"),
        );
        return "AUTH_DEAD";
      } catch (err) {
        this.state = previous;
        throw err;
      }
    });
  }

  health(): SessionHealth {
    const h: SessionHealth = { state: this.state };
    if (this.lastCheckAt !== undefined) h.lastCheckAt = new Date(this.lastCheckAt).toISOString();
    if (this.lastCheckTrigger !== undefined) h.lastCheckTrigger = this.lastCheckTrigger;
    return h;
  }
}
