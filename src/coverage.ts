// Coverage evidence parsing: turn `vitest --coverage` output into structured
// percentages so the DoD policy can gate on numeric thresholds.

export const COVERAGE_METRICS = ["lines", "statements", "branches", "functions"] as const;
export type CoverageMetric = (typeof COVERAGE_METRICS)[number];
export type CoverageSummary = Partial<Record<CoverageMetric, number>>;
export type CoverageRequirement = number | Partial<Record<CoverageMetric, number>>;

const percent = (n: number) => Math.round(n * 100) / 100;

function metricFromLabel(label: string): CoverageMetric | null {
  const l = label.toLowerCase();
  if (l.includes("stmt") || l.includes("statement")) return "statements";
  if (l.includes("branch")) return "branches";
  if (l.includes("func")) return "functions";
  if (l.includes("line")) return "lines";
  return null;
}

function numberFromCell(cell: string): number | undefined {
  const m = cell.match(/\d+(?:\.\d+)?/);
  if (!m) return undefined;
  return percent(Number(m[0]));
}

/** vitest's default text reporter prints an `All files` row under a header. */
function parseTable(text: string): CoverageSummary | null {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /Stmts/i.test(l) && /Lines/i.test(l) && l.includes("|"));
  if (headerIdx === -1) return null;

  const columns = new Map<CoverageMetric, number>();
  lines[headerIdx].split("|").forEach((label, i) => {
    const metric = metricFromLabel(label);
    if (metric && !columns.has(metric)) columns.set(metric, i);
  });
  if (!columns.size) return null;

  const row = lines.find((l) => /^\s*All files\s*\|/i.test(l));
  if (!row) return null;

  const cells = row.split("|");
  const out: CoverageSummary = {};
  for (const [metric, i] of columns) {
    const value = numberFromCell(cells[i] ?? "");
    if (value !== undefined) out[metric] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** istanbul/vitest `coverage-summary.json`, either `{total:{lines:{pct}}}` or flat. */
function parseJson(text: string): CoverageSummary | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const total = parsed?.total ?? parsed;
  if (!total || typeof total !== "object") return null;
  const out: CoverageSummary = {};
  for (const metric of COVERAGE_METRICS) {
    const entry = total[metric];
    const value = typeof entry === "number" ? entry : entry?.pct;
    if (typeof value === "number" && Number.isFinite(value)) out[metric] = percent(value);
  }
  return Object.keys(out).length ? out : null;
}

/** vitest's `text-summary` reporter: `Statements : 85.2% ( … )`. */
function parseTextSummary(text: string): CoverageSummary | null {
  const out: CoverageSummary = {};
  const re = /^\s*(statements?|branches?|functions?|lines?)\s*:\s*(\d+(?:\.\d+)?)\s*%/gim;
  for (const match of text.matchAll(re)) {
    const metric = metricFromLabel(match[1]);
    if (metric) out[metric] = percent(Number(match[2]));
  }
  return Object.keys(out).length ? out : null;
}

/** Arbitrary key/value pairs, e.g. `lines: 85.3, branches: 70%`. */
function parseKeyValues(text: string): CoverageSummary | null {
  const out: CoverageSummary = {};
  const re = /(?:^|[^a-z])(lines?|statements?|stmts?|branches?|functions?|funcs?)\s*[:=]\s*(\d+(?:\.\d+)?)\s*%?/gi;
  for (const match of text.matchAll(re)) {
    const metric = metricFromLabel(match[1]);
    if (metric) out[metric] = percent(Number(match[2]));
  }
  return Object.keys(out).length ? out : null;
}

/** A bare percentage is treated as line coverage (the documented convention). */
function parseBarePercent(text: string): CoverageSummary | null {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*%?$/);
  return m ? { lines: percent(Number(m[1])) } : null;
}

/**
 * Parse coverage output into lines/statements/branches/functions percentages.
 * Accepts vitest's text table, `coverage-summary.json`, text-summary lines, a
 * `lines: 85` key/value string, or a bare percentage. Returns null if nothing
 * recognisable was found.
 */
export function parseCoverage(text: string): CoverageSummary | null {
  if (!text) return null;
  return parseJson(text)
    ?? parseTable(text)
    ?? parseTextSummary(text)
    ?? parseKeyValues(text)
    ?? parseBarePercent(text);
}

export function normalizeCoverageRequirement(req: CoverageRequirement): Partial<Record<CoverageMetric, number>> {
  return typeof req === "number" ? { lines: req } : req;
}

/** Missing/threshold failures for a coverage requirement, as DoD messages. */
export function checkCoverage(summary: CoverageSummary | null, req: CoverageRequirement): string[] {
  if (!summary) return ["coverage could not be parsed"];
  const thresholds = normalizeCoverageRequirement(req);
  const missing: string[] = [];
  for (const metric of COVERAGE_METRICS) {
    const min = thresholds[metric];
    if (min === undefined) continue;
    const value = summary[metric];
    if (typeof value !== "number") {
      missing.push(`coverage ${metric} not reported (minimum ${min}%)`);
    } else if (value < min) {
      missing.push(`coverage ${metric} ${value}% below minimum ${min}%`);
    }
  }
  return missing;
}
