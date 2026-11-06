// Read-only board dashboard: server-rendered HTML, no dependencies, no JS.
// Auto-refreshes with a meta refresh so it works in any browser without assets.

const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
  )[ch]);

export type DashboardData = {
  tasks?: any[];
  locks?: any[];
  jobs?: any[];
  events?: any[];
  job_counts?: Array<{ status: string; n: number }>;
};

/** Server-rendered, dependency-free read-only view. Auto-refreshes via meta refresh. */
export function renderDashboard(data: DashboardData, opts: { refreshSeconds?: number } = {}): string {
  const refresh = opts.refreshSeconds ?? 5;
  const tasks = data.tasks ?? [];
  const locks = data.locks ?? [];
  const jobs = data.jobs ?? [];
  const events = data.events ?? [];
  const counts = data.job_counts ?? [];
  const jobSummary = counts.length ? counts.map((c) => `${c.n} ${c.status}`).join(" · ") : "no jobs";
  const cell = (value: unknown) => `<td>${escapeHtml(value)}</td>`;
  const rows = (items: any[], cols: number, render: (item: any) => string) =>
    items.length ? items.map(render).join("\n") : `<tr><td class="empty" colspan="${cols}">none</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>Underwright board</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:24px;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0f1115;color:#d6dae2}
main{max-width:1400px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;margin-bottom:8px}
h1{font-size:20px;margin:0}
h2{font-size:13px;margin:26px 0 8px;color:#9aa4b2;text-transform:uppercase;letter-spacing:.08em}
.meta{color:#6f7a89;margin:0}
.count{color:#4b5563;font-weight:normal}
table{width:100%;border-collapse:collapse;background:#151922;border:1px solid #232a36}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #1e2531;vertical-align:top}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8b95a5;background:#11151d}
tr:last-child td{border-bottom:0}
td code{color:#7dd3fc}
.title{color:#d6dae2}
.cmd{color:#c3cad6;word-break:break-all}
.empty{color:#566070;font-style:italic}
</style>
</head>
<body>
<main>
<header>
<h1>Underwright board</h1>
<p class="meta">read-only · auto-refresh ${refresh}s · rendered ${escapeHtml(new Date().toISOString())}</p>
</header>
<p class="meta">jobs: ${escapeHtml(jobSummary)} · tasks: ${tasks.length} · active locks: ${locks.length}</p>

<h2>Tasks <span class="count">${tasks.length}</span></h2>
<table>
<thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Claimed by</th><th>Lease expires</th></tr></thead>
<tbody>
${rows(tasks, 5, (t) => `<tr><td><code>${escapeHtml(t.id)}</code> <span class="title">${escapeHtml(t.title)}</span></td>${cell(t.status)}${cell(t.priority)}${cell(t.claimed_by ?? "—")}${cell(t.lease_expires ?? "—")}</tr>`)}
</tbody>
</table>

<h2>Active resource locks <span class="count">${locks.length}</span></h2>
<table>
<thead><tr><th>Resource</th><th>Agent</th><th>Task</th><th>Lease expires</th></tr></thead>
<tbody>
${rows(locks, 4, (l) => `<tr><td><code>${escapeHtml(l.resource)}</code></td>${cell(l.agent_id)}${cell(l.task_id ?? "—")}${cell(l.lease_expires)}</tr>`)}
</tbody>
</table>

<h2>Open jobs <span class="count">${jobs.length}</span></h2>
<table>
<thead><tr><th>Job</th><th>Type</th><th>Task</th><th>Status</th><th>Agent</th><th>Command</th><th>Created</th></tr></thead>
<tbody>
${rows(jobs, 7, (j) => `<tr><td><code>${escapeHtml(j.id)}</code></td>${cell(j.type)}${cell(j.task_id ?? "—")}${cell(j.status)}${cell(j.agent_id)}<td class="cmd">${escapeHtml(j.command)}</td>${cell(j.created_at)}</tr>`)}
</tbody>
</table>

<h2>Recent events <span class="count">${events.length}</span></h2>
<table>
<thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
<tbody>
${rows(events, 4, (e) => `<tr>${cell(e.created_at)}${cell(e.actor)}${cell(e.action)}<td><code>${escapeHtml(e.entity_type)}</code> ${escapeHtml(e.entity_id)}</td></tr>`)}
</tbody>
</table>
</main>
</body>
</html>`;
}
