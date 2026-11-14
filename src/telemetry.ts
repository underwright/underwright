// gh-136 telemetry port: OTel-shaped spans/metrics behind an interface so the
// backend is swappable — JSONL file (default), stdout, or off today; an OTLP
// adapter later. Correlation keys (trace_id, span_id, job/task/node/session
// ids) are emitted as span attributes so a future bridge is mechanical.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export interface SpanAttrs { [k: string]: string | number | boolean | null | undefined }

export interface Span {
  readonly trace_id: string;
  readonly span_id: string;
  /** Record a point-in-time inside the span (e.g. lease renewed, executor exited). */
  event(name: string, attrs?: SpanAttrs): void;
  end(status?: "ok" | "error", error?: unknown, attrs?: SpanAttrs): void;
}

export interface Telemetry {
  /** Start a span; parent links the trace when given, else a new trace starts. */
  span(name: string, attrs?: SpanAttrs, parent?: Span): Span;
  /** Standalone point event (poll outcome, session reauth, loop exit). */
  event(name: string, attrs?: SpanAttrs): void;
  /** Numeric observation (queue depth, running jobs, poll wait ms). */
  metric(name: string, value: number, attrs?: SpanAttrs): void;
}

type Line = { ts: string; kind: "span" | "event" | "metric"; name: string } & Record<string, unknown>;

class NoopTelemetry implements Telemetry {
  span(name: string, _a?: SpanAttrs, _p?: Span): Span {
    return { trace_id: "", span_id: "", event: () => {}, end: () => {} };
  }
  event(): void {}
  metric(): void {}
}

/** Appends one JSON object per line — ops/debugging output, rotation is the
 *  operator's (logrotate/journald) concern, same posture as console output. */
class Sink {
  constructor(private readonly write: (line: string) => void) {}
  emit(line: Line) { try { this.write(JSON.stringify(line) + "\n"); } catch { /* telemetry must never break the caller */ } }
}

class JsonlTelemetry implements Telemetry {
  constructor(private readonly sink: Sink, private readonly resource: SpanAttrs = {}) {}
  private base(): Pick<Line, "ts"> { return { ts: new Date().toISOString() }; }
  span(name: string, attrs: SpanAttrs = {}, parent?: Span): Span {
    const trace_id = parent?.trace_id || randomUUID();
    const span_id = randomBytes(8).toString("hex");
    const sink = this.sink, res = this.resource, base = this.base;
    const started = Date.now();
    sink.emit({ ...base(), kind: "span", name, phase: "start", trace_id, span_id,
      ...(parent ? { parent_span_id: parent.span_id } : {}), ...res, ...attrs });
    const events: Array<{ ts: string; name: string; attrs?: SpanAttrs }> = [];
    return {
      trace_id, span_id,
      event(evName: string, evAttrs?: SpanAttrs) { events.push({ ts: new Date().toISOString(), name: evName, attrs: evAttrs }); },
      end(status: "ok" | "error" = "ok", error?: unknown, endAttrs?: SpanAttrs) {
        sink.emit({ ...base(), kind: "span", name, phase: "end", trace_id, span_id,
          ...(parent ? { parent_span_id: parent.span_id } : {}), ...res, ...attrs, ...endAttrs,
          status, duration_ms: Date.now() - started,
          ...(events.length ? { events } : {}),
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) });
      },
    };
  }
  event(name: string, attrs: SpanAttrs = {}) {
    this.sink.emit({ ...this.base(), kind: "event", name, ...this.resource, ...attrs });
  }
  metric(name: string, value: number, attrs: SpanAttrs = {}) {
    this.sink.emit({ ...this.base(), kind: "metric", name, value, ...this.resource, ...attrs });
  }
}

let current: Telemetry = new NoopTelemetry();

/** Backend selection: UNDERWRIGHT_TELEMETRY=file|stdout|off (default off on
 *  import so library/test callers stay silent until entry points init). */
export function initTelemetry(opts: { backend?: string; file?: string; resource?: SpanAttrs } = {}): Telemetry {
  const backend = (opts.backend ?? process.env.UNDERWRIGHT_TELEMETRY ?? "off").toLowerCase();
  if (backend === "off" || backend === "noop") { current = new NoopTelemetry(); return current; }
  if (backend === "stdout") { current = new JsonlTelemetry(new Sink(l => process.stdout.write(l)), opts.resource); return current; }
  const file = opts.file ?? process.env.UNDERWRIGHT_TELEMETRY_FILE ?? "underwright-telemetry.jsonl";
  mkdirSync(dirname(file), { recursive: true });
  current = new JsonlTelemetry(new Sink(l => appendFileSync(file, l)), opts.resource);
  return current;
}

export function telemetry(): Telemetry { return current; }

/** Run fn inside a span; ends it with ok/error from the outcome. */
export async function withSpan<T>(name: string, attrs: SpanAttrs, fn: (span: Span) => T | Promise<T>, parent?: Span): Promise<T> {
  const s = telemetry().span(name, attrs, parent);
  try {
    const out = await fn(s);
    s.end("ok");
    return out;
  } catch (error) {
    s.end("error", error);
    throw error;
  }
}
