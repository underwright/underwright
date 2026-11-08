// Read-only board dashboard: server-rendered HTML, no dependencies, no JS.
// Auto-refreshes with a meta refresh so it works in any browser without assets.

const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
  )[ch]);

function eventPayload(event: any): Record<string, unknown> {
  const raw = event?.data;
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Dependency-blocked tasks and escalation artifacts (kind blocked) share one highlight. */
function isBlockedTask(task: any): boolean {
  return task?.status === "blocked" || Number(task?.blocked_artifacts) > 0;
}

function isBlockedEvent(event: any): boolean {
  return event?.action === "blocked" || eventPayload(event).kind === "blocked";
}

export type DashboardData = {
  tasks?: any[];
  locks?: any[];
  jobs?: any[];
  events?: any[];
  job_counts?: Array<{ status: string; n: number }>;
  nodes?: any[];
};

/** Server-rendered, dependency-free read-only view. Auto-refreshes via meta refresh. */
export function renderDashboard(data: DashboardData, opts: { refreshSeconds?: number } = {}): string {
  const refresh = opts.refreshSeconds ?? 5;
  const tasks = data.tasks ?? [];
  const escalations = tasks.filter((task) => Number(task.blocked_artifacts) > 0);
  const locks = data.locks ?? [];
  const jobs = data.jobs ?? [];
  const events = data.events ?? [];
  const nodes = data.nodes ?? [];
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
tr.blocked{background:#3a2416}
tr.blocked td,tr.blocked .title{color:#f6c27a}
.badge-blocked{display:inline-block;margin-left:6px;padding:0 6px;border:1px solid #a16207;border-radius:999px;color:#f6c27a;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
</style>
</head>
<body>
<main>
<header>
<h1>Underwright board</h1>
<p class="meta">read-only · auto-refresh ${refresh}s · rendered ${escapeHtml(new Date().toISOString())}</p>
</header>
<p class="meta">jobs: ${escapeHtml(jobSummary)} · tasks: ${tasks.length} · active locks: ${locks.length} · nodes: ${nodes.length}</p>

<h2>Tasks <span class="count">${tasks.length}</span></h2>
<table>
<thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Claimed by</th><th>Lease expires</th></tr></thead>
<tbody>
${rows(tasks, 5, (t) => {
  const escalated = Number(t.blocked_artifacts) > 0;
  const badge = escalated ? ` <span class="badge-blocked">escalation</span>` : "";
  return `<tr${isBlockedTask(t) ? ' class="blocked"' : ""}><td><code>${escapeHtml(t.id)}</code> <span class="title">${escapeHtml(t.title)}</span>${badge}</td>${cell(t.status)}${cell(t.priority)}${cell(t.claimed_by ?? "—")}${cell(t.lease_expires ?? "—")}</tr>`;
})}
</tbody>
</table>

<h2>Blocked escalations <span class="count">${escalations.length}</span></h2>
<table>
<thead><tr><th>Task</th><th>Status</th><th>Claimed by</th><th>Escalations</th></tr></thead>
<tbody>
${rows(escalations, 4, (t) => `<tr class="blocked"><td><code>${escapeHtml(t.id)}</code> <span class="title">${escapeHtml(t.title)}</span></td>${cell(t.status)}${cell(t.claimed_by ?? "—")}${cell(t.blocked_artifacts)}</tr>`)}
</tbody>
</table>

<h2>Active resource locks <span class="count">${locks.length}</span></h2>
<table>
<thead><tr><th>Resource</th><th>Agent</th><th>Task</th><th>Lease expires</th></tr></thead>
<tbody>
${rows(locks, 4, (l) => `<tr><td><code>${escapeHtml(l.resource)}</code></td>${cell(l.agent_id)}${cell(l.task_id ?? "—")}${cell(l.lease_expires)}</tr>`)}
</tbody>
</table>

<h2>Nodes <span class="count">${nodes.length}</span></h2>
<table>
<thead><tr><th>Node</th><th>State</th><th>Liveness</th><th>Last heartbeat</th><th>Current job</th><th>Capabilities</th><th>Harnesses</th></tr></thead>
<tbody>
${rows(nodes, 7, (n) => `<tr><td><code>${escapeHtml(n.id)}</code> <span class="title">${escapeHtml(n.name)}</span></td>${cell(n.state)}${cell(n.liveness)}${cell(n.last_seen_at ?? "—")}${cell(n.current_job_id ?? "—")}${cell(n.capabilities_freshness)}${cell((n.harnesses ?? []).map((h: any) => h.id).join(", ") || "—")}</tr>`)}
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
${rows(events, 4, (e) => `<tr${isBlockedEvent(e) ? ' class="blocked"' : ""}>${cell(e.created_at)}${cell(e.actor)}${cell(e.action)}<td><code>${escapeHtml(e.entity_type)}</code> ${escapeHtml(e.entity_id)}</td></tr>`)}
</tbody>
</table>
</main>
</body>
</html>`;
}

// ---------- Interactive surface ----------
// Task detail, create/claim/release, and inbox via plain HTML forms — works
// with zero client JS. Token propagates through links/forms as ?token=.

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:24px;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#0f1115;color:#d6dae2}
main{max-width:1100px}
h1{font-size:20px;margin:0 0 4px} h2{font-size:13px;margin:22px 0 8px;color:#9aa4b2;text-transform:uppercase;letter-spacing:.08em}
a{color:#7dd3fc}
table{width:100%;border-collapse:collapse;background:#151922;border:1px solid #232a36}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #1e2531;vertical-align:top}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8b95a5;background:#11151d}
input,select,textarea{background:#11151d;color:#d6dae2;border:1px solid #2a3342;padding:6px 8px;font:inherit;border-radius:4px}
textarea{width:100%;min-height:80px}
button{background:#1d4ed8;color:#fff;border:0;border-radius:4px;padding:6px 14px;font:inherit;cursor:pointer}
button:hover{background:#2563eb}
form.inline{display:inline}
form.stack{display:flex;flex-direction:column;gap:8px;max-width:640px}
.meta{color:#6f7a89}.empty{color:#566070;font-style:italic}
pre.desc{white-space:pre-wrap;background:#11151d;border:1px solid #232a36;padding:10px;border-radius:6px;max-height:400px;overflow:auto}
.badge{display:inline-block;padding:1px 8px;border:1px solid #334155;border-radius:999px;font-size:11px;color:#9aa4b2}
nav{margin-bottom:14px;font-size:13px}
</style></head><body><main>${body}</main></body></html>`;

const tok = (t?: string) => t ? `?token=${encodeURIComponent(t)}` : "";
const tokAnd = (t?: string) => t ? `&token=${encodeURIComponent(t)}` : "";

export function renderTaskPage(task: any, opts: { token?: string } = {}): string {
  const t = opts.token;
  const ac = (task.ac_ids ?? []).map((a: string) => `<span class="badge">${escapeHtml(a)}</span>`).join(" ");
  const evidence = (task.evidence ?? []).map((e: any) =>
    `<tr><td>${escapeHtml(e.created_at)}</td><td>${escapeHtml(e.kind)}</td><td>${escapeHtml(e.agent_id)}</td><td>${escapeHtml(e.exit_code ?? "—")}</td><td><pre class="desc">${escapeHtml((e.output ?? "").slice(0, 2000))}</pre></td></tr>`).join("\n");
  const artifacts = (task.artifacts ?? []).map((a: any) =>
    `<tr><td>${escapeHtml(a.created_at)}</td><td>${escapeHtml(a.kind)}</td><td>${escapeHtml(a.agent_id)}</td><td>${escapeHtml(a.title ?? "—")}</td><td><pre class="desc">${escapeHtml((a.content ?? "").slice(0, 2000))}</pre></td></tr>`).join("\n");
  const claim = task.claim;
  const actions = claim
    ? `<form class="inline" method="post" action="/task/${escapeHtml(task.id)}/release${tok(t)}"><input type="hidden" name="agent_id" value="${escapeHtml(claim.agent_id)}"><button>Release claim (${escapeHtml(claim.agent_id)})</button></form>`
    : `<form class="inline" method="post" action="/task/${escapeHtml(task.id)}/claim${tok(t)}"><input name="agent_id" placeholder="agent@host" required><button>Claim</button></form>`;
  return shell(`Task ${task.id}`, `
<nav><a href="/board${tok(t)}">← board</a> · <a href="/inbox/you${tok(t)}">inbox</a></nav>
<h1>${escapeHtml(task.title)}</h1>
<p class="meta"><code>${escapeHtml(task.id)}</code> · ${escapeHtml(task.status)} · p${escapeHtml(task.priority)} · ${escapeHtml(task.type)} · created by ${escapeHtml(task.created_by)}</p>
<p>${ac || '<span class="empty">no acceptance criteria</span>'}</p>
<p>${actions}</p>
<h2>Description</h2><pre class="desc">${escapeHtml(task.description || "—")}</pre>
<h2>Post artifact</h2>
<form class="stack" method="post" action="/task/${escapeHtml(task.id)}/artifact${tok(t)}">
<input name="agent_id" placeholder="agent@host" required>
<select name="kind"><option>note</option><option>spec</option><option>design</option><option>handoff</option><option>review</option><option>blocked</option></select>
<input name="title" placeholder="title">
<textarea name="content" required></textarea><button>Post</button></form>
<h2>Report evidence</h2>
<form class="stack" method="post" action="/task/${escapeHtml(task.id)}/evidence${tok(t)}">
<input name="agent_id" placeholder="agent@host" required>
<select name="kind"><option>test_run</option><option>ci_check</option><option>review</option><option>coverage</option><option>deploy</option><option>contract_test</option><option>security_scan</option><option>smoke_test</option><option>mutation</option><option>cost</option></select>
<input name="command" placeholder="command run">
<input name="exit_code" type="number" placeholder="exit code">
<input name="ac_ids" placeholder="ac ids, comma-separated">
<textarea name="output" placeholder="output / results"></textarea><button>Report</button></form>
<h2>Evidence <span class="meta">${(task.evidence ?? []).length}</span></h2>
<table><tbody>${evidence || '<tr><td class="empty">none</td></tr>'}</tbody></table>
<h2>Artifacts <span class="meta">${(task.artifacts ?? []).length}</span></h2>
<table><tbody>${artifacts || '<tr><td class="empty">none</td></tr>'}</tbody></table>`);
}

export function renderInboxPage(agentId: string, messages: any[], opts: { token?: string } = {}): string {
  const t = opts.token;
  const rows = messages.map((m: any) =>
    `<tr><td>${escapeHtml(m.created_at)}</td><td>${escapeHtml(m.from_agent)}</td><td>${escapeHtml(m.task_id ?? "—")}</td><td>${escapeHtml(m.body)}</td></tr>`).join("\n");
  return shell(`Inbox ${agentId}`, `
<nav><a href="/board${tok(t)}">← board</a></nav>
<h1>Inbox — ${escapeHtml(agentId)}</h1>
<p class="meta">reading marks messages read · <a href="/inbox/${escapeHtml(agentId)}?all=1${tokAnd(t)}">all messages</a></p>
<form class="inline" method="get" action="/inbox/" onsubmit="return false"><input name="agent" placeholder="agent@host" onkeydown="if(event.key==='Enter')location='/inbox/'+encodeURIComponent(this.value)+'${tok(t)}'"></form>
<h2>Messages <span class="meta">${messages.length}</span></h2>
<table><tbody>${rows || '<tr><td class="empty">empty</td></tr>'}</tbody></table>
<h2>Send message</h2>
<form class="stack" method="post" action="/messages${tok(t)}">
<input name="to_agent" placeholder="to agent@host" required>
<input name="from_agent" value="${escapeHtml(agentId)}" required>
<input name="task_id" placeholder="task id (optional)">
<textarea name="body" required></textarea><button>Send</button></form>`);
}

export interface DashboardResult { html?: string; redirect?: string; error?: string; status?: number }

/** Interactive dashboard router. Returns {html} or {redirect}; errors as {error,status}. */
export async function handleDashboardRequest(store: any, method: string, url: URL, body: URLSearchParams, token?: string): Promise<DashboardResult> {
  const path = url.pathname;
  const form = (k: string) => (body.get(k) ?? "").trim() || undefined;
  if (method === "POST") {
    const back = (id: string) => ({ redirect: `${id}${tok(token)}` });
    if (path === "/tasks") {
      const title = form("title");
      if (!title) return { error: "title required", status: 400 };
      const task = await store.createTask({ title, description: form("description"), type: form("type") ?? "feature", ac_ids: form("ac_ids")?.split(",").map(s => s.trim()).filter(Boolean), created_by: form("agent_id") ?? "dashboard" });
      return { redirect: `/task/${task.id}${tok(token)}` };
    }
    if (path === "/messages") {
      const to = form("to_agent"), from = form("from_agent"), msg = form("body");
      if (!to || !from || !msg) return { error: "to_agent, from_agent, body required", status: 400 };
      await store.sendMessage(to, from, msg, form("task_id"));
      return { redirect: `/inbox/${encodeURIComponent(from)}${tok(token)}` };
    }
    const m = path.match(/^\/task\/([^/]+)\/(claim|release|artifact|evidence)$/);
    if (m) {
      const [, id, action] = m;
      const agent = form("agent_id") ?? "dashboard";
      let result: any;
      if (action === "claim") result = await store.claimTask(id, agent);
      else if (action === "release") result = await store.releaseTask(id, agent);
      else if (action === "artifact") result = await store.postArtifact({ task_id: id, agent_id: agent, kind: form("kind") ?? "note", title: form("title"), content: form("content") ?? "" });
      else result = await store.reportEvidence({ task_id: id, agent_id: agent, kind: form("kind") ?? "test_run", command: form("command"), exit_code: form("exit_code") !== undefined ? Number(form("exit_code")) : undefined, output: form("output"), ac_ids: form("ac_ids")?.split(",").map(s => s.trim()).filter(Boolean) });
      if (result?.error) return { error: result.error, status: 409 };
      return back(`/task/${id}`);
    }
    return { error: "unknown action", status: 404 };
  }
  if (path === "/" || path === "/board") {
    const data = await store.dashboard();
    const taskLinks = (data.tasks ?? []).map((t: any) => ({ ...t, title: t.title }));
    const html = renderDashboard(data, { refreshSeconds: Number(url.searchParams.get("refresh") ?? 15) })
      .replace("</main>", `
<h2>Create task</h2>
<form class="stack" method="post" action="/tasks${tok(token)}">
<input name="title" placeholder="title" required>
<textarea name="description" placeholder="description (markdown)"></textarea>
<select name="type"><option>feature</option><option>bug</option><option>architecture</option><option>docs</option><option>tdd</option></select>
<input name="ac_ids" placeholder="ac ids, comma-separated">
<input name="agent_id" placeholder="created-by agent@host">
<button>Create</button></form>
<h2>Mailbox</h2>
<form class="inline" method="get" onsubmit="return false"><input name="agent" placeholder="agent@host" onkeydown="if(event.key==='Enter')location='/inbox/'+encodeURIComponent(this.value)+'${tok(token)}'"><button type="button" onclick="location='/inbox/'+encodeURIComponent(this.previousSibling.value)+'${tok(token)}'">Open inbox</button></form>
</main>`)
      .replace(/<code>(task-[a-f0-9]+|gh-\d+|init-[a-z-]+)<\/code>/g, (_m, id) => `<a href="/task/${id}${tok(token)}"><code>${id}</code></a>`)
      .replace("</style>", `a{color:#7dd3fc}input,select,textarea{background:#11151d;color:#d6dae2;border:1px solid #2a3342;padding:6px 8px;font:inherit;border-radius:4px}textarea{width:100%;min-height:60px}button{background:#1d4ed8;color:#fff;border:0;border-radius:4px;padding:6px 14px;font:inherit;cursor:pointer}form.stack{display:flex;flex-direction:column;gap:8px;max-width:640px}form.inline{display:inline}</style>`);
    void taskLinks;
    return { html };
  }
  const tm = path.match(/^\/task\/([^/]+)$/);
  if (tm) {
    const task = await store.getTask(tm[1]);
    if (!task) return { error: "task not found", status: 404 };
    try { task.evidence = await store.getEvidence(tm[1]); } catch { task.evidence = []; }
    return { html: renderTaskPage(task, { token }) };
  }
  const im = path.match(/^\/inbox\/([^/]+)$/);
  if (im) {
    const agent = decodeURIComponent(im[1]);
    const messages = await store.inbox(agent, url.searchParams.get("all") !== "1");
    return { html: renderInboxPage(agent, messages, { token }) };
  }
  return { error: "not found", status: 404 };
}
