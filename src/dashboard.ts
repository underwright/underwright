// Board dashboard: server-rendered HTML, no dependencies, no client JS required.
// Auto-refreshes with a meta refresh so it works in any browser without assets.
// Responsive: on phones/tablets tables collapse into labelled cards (MOBILE_CSS).
import { createHash, timingSafeEqual } from "node:crypto";

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

/** Narrow screens (phones, portrait tablets): tables collapse into labelled cards,
 *  tap targets grow, and inputs use 16px text so iOS does not zoom on focus. */
export const MOBILE_CSS = `@media (max-width:720px){
body{padding:12px;font-size:15px}
h1{font-size:18px}
table,thead,tbody,tr,td{display:block;width:100%}
thead{display:none}
table{background:none;border:0}
tr{background:#151922;border:1px solid #232a36;border-radius:8px;margin-bottom:10px;padding:6px 0}
td{border:0;padding:4px 12px;word-break:break-word}
td[data-label]::before{content:attr(data-label);display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8b95a5}
input,select,textarea,button{font-size:16px;min-height:44px}
form.stack{max-width:none}
nav a{display:inline-block;padding:8px 4px}
}`;

const PWA_META = `<meta name="theme-color" content="#0f1115"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">`;

type Column = { label: string; render: (item: any) => string; cls?: string };

/** One table section. Every cell carries data-label so the mobile card layout can title it. */
function section(title: string, items: any[], columns: Column[], rowClass: (item: any) => string = () => ""): string {
  const head = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  const body = items.length
    ? items.map((item) => {
      const cls = rowClass(item);
      const cells = columns.map((c) => `<td data-label="${escapeHtml(c.label)}"${c.cls ? ` class="${c.cls}"` : ""}>${c.render(item)}</td>`).join("");
      return `<tr${cls ? ` class="${cls}"` : ""}>${cells}</tr>`;
    }).join("\n")
    : `<tr><td class="empty" colspan="${columns.length}">none</td></tr>`;
  return `<h2>${escapeHtml(title)} <span class="count">${items.length}</span></h2>
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

// ---------- Task list filters + sorting (query-param driven, zero JS) ----------
export const TASK_STATUS_FILTERS = ["active", "all", "open", "claimed", "in_review", "done", "blocked"] as const;
export const TASK_SORTS = ["priority", "status", "updated", "claimed_by"] as const;
export type TaskListQuery = { status: string; q: string; sort: string };

/** Parse ?status=&q=&sort= . Unknown values fall back to the defaults (active / "" / priority). */
export function parseTaskQuery(url: URL): TaskListQuery {
  const status = url.searchParams.get("status") ?? "active";
  const sort = url.searchParams.get("sort") ?? "priority";
  return {
    status: (TASK_STATUS_FILTERS as readonly string[]).includes(status) ? status : "active",
    q: (url.searchParams.get("q") ?? "").trim(),
    sort: (TASK_SORTS as readonly string[]).includes(sort) ? sort : "priority",
  };
}

/** Filter by status (blocked = status 'blocked' or has escalations), search id/title, then sort.
 *  Pure: returns a new array; the input is not mutated. Ties keep the store's priority order. */
export function filterSortTasks(tasks: any[], query: TaskListQuery): any[] {
  const needle = query.q.toLowerCase();
  const out = tasks.filter((t) => {
    if (query.status === "blocked" && !isBlockedTask(t)) return false;
    if (query.status === "active" && t.status === "done") return false;
    if (query.status !== "all" && query.status !== "blocked" && query.status !== "active" && t.status !== query.status) return false;
    if (needle && !`${t.id ?? ""} ${t.title ?? ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const byPriority = (a: any, b: any) => Number(a.priority ?? 0) - Number(b.priority ?? 0);
  const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  switch (query.sort) {
    case "status":
      return out.sort((a, b) => cmpStr(String(a.status ?? ""), String(b.status ?? "")) || byPriority(a, b));
    case "updated":
      return out.sort((a, b) => cmpStr(String(b.updated_at ?? ""), String(a.updated_at ?? "")) || byPriority(a, b));
    case "claimed_by":
      // Unclaimed tasks sort last.
      return out.sort((a, b) => {
        const ca = a.claimed_by ?? "￿", cb = b.claimed_by ?? "￿";
        return cmpStr(ca, cb) || byPriority(a, b);
      });
    default:
      return out.sort(byPriority);
  }
}

/** GET form for the task list. Zero JS; the token rides as a hidden field so it survives submit. */
function taskControls(query: TaskListQuery, opts: { token?: string; refreshSeconds?: number }): string {
  const sel = (name: string, options: readonly string[], current: string) =>
    `<select name="${name}">${options.map((o) => `<option value="${o}"${o === current ? " selected" : ""}>${o}</option>`).join("")}</select>`;
  const hidden = [
    opts.token ? `<input type="hidden" name="token" value="${escapeHtml(opts.token)}">` : "",
    opts.refreshSeconds !== undefined ? `<input type="hidden" name="refresh" value="${escapeHtml(String(opts.refreshSeconds))}">` : "",
  ].join("");
  return `<form class="inline task-filters" method="get" action="/board">${hidden}
${sel("status", TASK_STATUS_FILTERS, query.status)}
<input name="q" placeholder="search id or title" value="${escapeHtml(query.q)}">
${sel("sort", TASK_SORTS, query.sort)}
<button>Apply</button>
<a href="/board${opts.token ? `?token=${encodeURIComponent(opts.token)}` : ""}">clear</a>
</form>`;
}

const field = (key: string, fallback?: string) => (item: any) => escapeHtml(item?.[key] ?? fallback);
const idTitle = (titleKey: string) => (item: any) => `<code>${escapeHtml(item.id)}</code> <span class="title">${escapeHtml(item[titleKey])}</span>`;

/** Server-rendered, dependency-free read-only view. Auto-refreshes via meta refresh. */
export function renderDashboard(data: DashboardData, opts: { refreshSeconds?: number; tasks?: { query: TaskListQuery; token?: string } } = {}): string {
  const refresh = opts.refreshSeconds ?? 5;
  const allTasks = data.tasks ?? [];
  // Filter/sort controls are shown only when a task query is supplied (the /board route does).
  const tasks = opts.tasks ? filterSortTasks(allTasks, opts.tasks.query) : allTasks;
  const escalations = tasks.filter((task) => Number(task.blocked_artifacts) > 0);
  const locks = data.locks ?? [];
  const jobs = data.jobs ?? [];
  const events = data.events ?? [];
  const nodes = data.nodes ?? [];
  const counts = data.job_counts ?? [];
  const jobSummary = counts.length ? counts.map((c) => `${c.n} ${c.status}`).join(" · ") : "no jobs";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
${PWA_META}
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
${MOBILE_CSS}
</style>
</head>
<body>
<main>
<header>
<h1>Underwright board</h1>
<p class="meta">read-only · auto-refresh ${refresh}s · rendered ${escapeHtml(new Date().toISOString())}</p>
</header>
<p class="meta">jobs: ${escapeHtml(jobSummary)} · tasks: ${tasks.length} · active locks: ${locks.length} · nodes: ${nodes.length}</p>

${opts.tasks ? taskControls(opts.tasks.query, { token: opts.tasks.token, refreshSeconds: refresh }) : ""}
${section("Tasks", tasks, [
  { label: "Task", render: (t) => idTitle("title")(t) + (Number(t.blocked_artifacts) > 0 ? ` <span class="badge-blocked">escalation</span>` : "") },
  { label: "Status", render: field("status") },
  { label: "Priority", render: field("priority") },
  { label: "Claimed by", render: field("claimed_by", "—") },
  { label: "Lease expires", render: field("lease_expires", "—") },
], (t) => isBlockedTask(t) ? "blocked" : "")}

${section("Blocked escalations", escalations, [
  { label: "Task", render: idTitle("title") },
  { label: "Status", render: field("status") },
  { label: "Claimed by", render: field("claimed_by", "—") },
  { label: "Escalations", render: field("blocked_artifacts") },
], () => "blocked")}

${section("Active resource locks", locks, [
  { label: "Resource", render: (l) => `<code>${escapeHtml(l.resource)}</code>` },
  { label: "Agent", render: field("agent_id") },
  { label: "Task", render: field("task_id", "—") },
  { label: "Lease expires", render: field("lease_expires") },
])}

${section("Nodes", nodes, [
  { label: "Node", render: idTitle("name") },
  { label: "State", render: field("state") },
  { label: "Liveness", render: field("liveness") },
  { label: "Last heartbeat", render: field("last_seen_at", "—") },
  { label: "Current job", render: field("current_job_id", "—") },
  { label: "Capabilities", render: field("capabilities_freshness") },
  { label: "Harnesses", render: (n) => escapeHtml((n.harnesses ?? []).map((h: any) => h.id).join(", ") || "—") },
])}

${section("Open jobs", jobs, [
  { label: "Job", render: (j) => `<code>${escapeHtml(j.id)}</code>` },
  { label: "Type", render: field("type") },
  { label: "Task", render: field("task_id", "—") },
  { label: "Status", render: field("status") },
  { label: "Agent", render: field("agent_id") },
  { label: "Command", render: field("command"), cls: "cmd" },
  { label: "Created", render: field("created_at") },
])}

${section("Recent events", events, [
  { label: "Time", render: field("created_at") },
  { label: "Actor", render: field("actor") },
  { label: "Action", render: field("action") },
  { label: "Entity", render: (e) => `<code>${escapeHtml(e.entity_type)}</code> ${escapeHtml(e.entity_id)}` },
], (e) => isBlockedEvent(e) ? "blocked" : "")}
</main>
</body>
</html>`;
}

// ---------- Interactive surface ----------
// Task detail, create/claim/release, inbox and chat via plain HTML forms —
// works with zero client JS. Token propagates through links/forms as ?token=
// (or rides the uw_token cookie set by the server, see serveHttp).

const shell = (title: string, body: string, opts: { head?: string } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${PWA_META}${opts.head ?? ""}
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
.chatlog{width:100%;height:60vh;border:1px solid #232a36;border-radius:8px;background:#0c0e12}
.msg{max-width:85%;margin:8px 0;padding:8px 12px;border-radius:12px;background:#1b2130;white-space:pre-wrap;word-break:break-word}
.msg.mine{margin-left:auto;background:#1e3a8a}
.msg .who{display:block;font-size:11px;color:#9aa4b2}
ul.peers{list-style:none;padding:0;margin:0}
ul.peers li a{display:block;padding:10px 12px;border:1px solid #232a36;border-radius:8px;margin-bottom:6px;background:#151922;text-decoration:none}
${MOBILE_CSS}
</style></head><body><main>${body}</main></body></html>`;

const tok = (t?: string) => t ? `?token=${encodeURIComponent(t)}` : "";
const tokAnd = (t?: string) => t ? `&token=${encodeURIComponent(t)}` : "";
/** Query string from params; drops empty values; token appended last. */
const qs = (params: Record<string, string | undefined>, token?: string) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  if (token) p.set("token", token);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export function renderTaskPage(task: any, opts: { token?: string } = {}): string {
  const t = opts.token;
  const ac = (task.ac_ids ?? []).map((a: string) => `<span class="badge">${escapeHtml(a)}</span>`).join(" ");
  const evidence = (task.evidence ?? []).map((e: any) =>
    `<tr><td data-label="When">${escapeHtml(e.created_at)}</td><td data-label="Kind">${escapeHtml(e.kind)}</td><td data-label="Agent">${escapeHtml(e.agent_id)}</td><td data-label="Exit">${escapeHtml(e.exit_code ?? "—")}</td><td data-label="Output"><pre class="desc">${escapeHtml((e.output ?? "").slice(0, 2000))}</pre></td></tr>`).join("\n");
  const artifacts = (task.artifacts ?? []).map((a: any) =>
    `<tr><td data-label="When">${escapeHtml(a.created_at)}</td><td data-label="Kind">${escapeHtml(a.kind)}</td><td data-label="Agent">${escapeHtml(a.agent_id)}</td><td data-label="Title">${escapeHtml(a.title ?? "—")}</td><td data-label="Content"><pre class="desc">${escapeHtml((a.content ?? "").slice(0, 2000))}</pre></td></tr>`).join("\n");
  const claim = task.claim;
  const actions = claim
    ? `<form class="inline" method="post" action="/task/${escapeHtml(task.id)}/release${tok(t)}"><input type="hidden" name="agent_id" value="${escapeHtml(claim.agent_id)}"><button>Release claim (${escapeHtml(claim.agent_id)})</button></form>
<a href="/chat/${encodeURIComponent(claim.agent_id)}${qs({ task: task.id }, t)}">chat with ${escapeHtml(claim.agent_id)}</a>`
    : `<form class="inline" method="post" action="/task/${escapeHtml(task.id)}/claim${tok(t)}"><input name="agent_id" placeholder="agent@host" required><button>Claim</button></form>`;
  return shell(`Task ${task.id}`, `
<nav><a href="/board${tok(t)}">← board</a> · <a href="/chat${tok(t)}">chat</a> · <a href="/inbox/human${tok(t)}">inbox</a></nav>
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
    `<tr><td data-label="When">${escapeHtml(m.created_at)}</td><td data-label="From"><a href="/chat/${encodeURIComponent(m.from_agent)}${qs({ me: agentId }, t)}">${escapeHtml(m.from_agent)}</a></td><td data-label="Task">${escapeHtml(m.task_id ?? "—")}</td><td data-label="Message">${escapeHtml(m.body)}</td></tr>`).join("\n");
  return shell(`Inbox ${agentId}`, `
<nav><a href="/board${tok(t)}">← board</a> · <a href="/chat${qs({ me: agentId }, t)}">chat</a></nav>
<h1>Inbox — ${escapeHtml(agentId)}</h1>
<p class="meta">reading marks messages read · <a href="/inbox/${encodeURIComponent(agentId)}?all=1${tokAnd(t)}">all messages</a></p>
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

// ---------- Remote chat ----------
// A thread between the operator (default identity "human") and one agent,
// carried on the ordinary mailbox: agents read it with `inbox` and reply with
// `send_message` to "human". The log lives in an auto-refreshing iframe so the
// compose box never loses what you are typing — still zero client JS.

export const DEFAULT_OPERATOR = "human";
const MAX_AGENT_ID = 200;
const MAX_CHAT_BODY = 16 * 1024;

/** Agent ids for the chat picker: claim holders first, then lock/job holders and recent actors. */
export function chatPeers(data: DashboardData, me: string): string[] {
  const seen = new Set<string>();
  const add = (id: unknown) => {
    const s = typeof id === "string" ? id.trim() : "";
    if (s && s !== me && s.length <= MAX_AGENT_ID) seen.add(s);
  };
  for (const t of data.tasks ?? []) add(t.claimed_by);
  for (const l of data.locks ?? []) add(l.agent_id);
  for (const j of data.jobs ?? []) add(j.agent_id);
  for (const e of data.events ?? []) add(e.actor);
  return [...seen];
}

export function renderChatIndex(me: string, peers: string[], opts: { token?: string } = {}): string {
  const t = opts.token;
  const list = peers.map((p) => `<li><a href="/chat/${encodeURIComponent(p)}${qs({ me: me === DEFAULT_OPERATOR ? undefined : me }, t)}">${escapeHtml(p)}</a></li>`).join("\n");
  return shell("Chat", `
<nav><a href="/board${tok(t)}">← board</a> · <a href="/inbox/${encodeURIComponent(me)}${tok(t)}">inbox (${escapeHtml(me)})</a></nav>
<h1>Chat</h1>
<p class="meta">you are <code>${escapeHtml(me)}</code> · agents reply with <code>send_message to="${escapeHtml(me)}"</code></p>
<h2>Agents <span class="meta">${peers.length}</span></h2>
${list ? `<ul class="peers">${list}</ul>` : '<p class="empty">no active agents</p>'}
<h2>Open a thread</h2>
<form class="stack" method="get" action="/chat/open">
<input name="peer" placeholder="agent@host" required>
<input name="me" value="${escapeHtml(me)}">
${t ? `<input type="hidden" name="token" value="${escapeHtml(t)}">` : ""}
<button>Open</button></form>`);
}

export function renderChatPage(me: string, peer: string, opts: { token?: string; taskId?: string } = {}): string {
  const t = opts.token;
  const meParam = me === DEFAULT_OPERATOR ? undefined : me;
  const logSrc = `/chat/${encodeURIComponent(peer)}/log${qs({ me: meParam }, t)}#end`;
  return shell(`Chat — ${peer}`, `
<nav><a href="/chat${qs({ me: meParam }, t)}">← chats</a> · <a href="/board${tok(t)}">board</a></nav>
<h1>${escapeHtml(peer)}</h1>
<p class="meta">as <code>${escapeHtml(me)}</code> · thread refreshes every 5s</p>
<iframe class="chatlog" title="conversation" src="${escapeHtml(logSrc)}"></iframe>
<form class="stack" method="post" action="/chat/${encodeURIComponent(peer)}${tok(t)}">
<input type="hidden" name="me" value="${escapeHtml(me)}">
<textarea name="body" placeholder="message ${escapeHtml(peer)}" required autofocus></textarea>
<input name="task_id" placeholder="task id (optional)" value="${escapeHtml(opts.taskId ?? "")}">
<button>Send</button></form>`);
}

export function renderChatLog(me: string, peer: string, messages: any[], opts: { token?: string; refreshSeconds?: number } = {}): string {
  const refresh = opts.refreshSeconds ?? 5;
  const self = `/chat/${encodeURIComponent(peer)}/log${qs({ me: me === DEFAULT_OPERATOR ? undefined : me }, opts.token)}#end`;
  const bubbles = messages.map((m: any) => {
    const mine = m.from_agent === me;
    const task = m.task_id ? ` · ${escapeHtml(m.task_id)}` : "";
    return `<div class="msg${mine ? " mine" : ""}"><span class="who">${escapeHtml(m.from_agent)} · ${escapeHtml(m.created_at)}${task}${!mine || m.read ? "" : " · unread"}</span>${escapeHtml(m.body)}</div>`;
  }).join("\n");
  return shell(`Chat log — ${peer}`, `${bubbles || '<p class="empty">no messages yet — say hello</p>'}<div id="end"></div>`,
    { head: `<meta http-equiv="refresh" content="${refresh};url=${escapeHtml(self)}"><base target="_top">` })
    .replace("<body>", '<body style="padding:8px">');
}

// ---------- Remote reach: dashboard auth ----------
// Phones can't set Authorization headers on plain links, and ?token= in every
// URL leaks into history/screenshots. /login?token=… trades the token for an
// HttpOnly SameSite=Strict cookie (Strict also blocks cross-site form CSRF).

export const SESSION_COOKIE = "uw_token";
const SESSION_MAX_AGE = 30 * 24 * 3600;

const sameSecret = (a: string | undefined | null, b: string): boolean => {
  if (typeof a !== "string") return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
};

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

export type DashboardAuth = { ok: boolean; via?: "open" | "bearer" | "query" | "cookie" };

/** Dashboard auth: open when no token is configured; else bearer header, ?token=, or session cookie. */
export function dashboardAuth(token: string | undefined, headers: { authorization?: string; cookie?: string }, url: URL): DashboardAuth {
  if (!token) return { ok: true, via: "open" };
  if (sameSecret(headers.authorization, `Bearer ${token}`)) return { ok: true, via: "bearer" };
  if (sameSecret(url.searchParams.get("token"), token)) return { ok: true, via: "query" };
  if (sameSecret(readCookie(headers.cookie, SESSION_COOKIE), token)) return { ok: true, via: "cookie" };
  return { ok: false };
}

/** Set-Cookie value for a dashboard session. `secure` when served over HTTPS (directly or via proxy). */
export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}${secure ? "; Secure" : ""}`;
}

export interface DashboardResult { html?: string; redirect?: string; error?: string; status?: number }

const validAgent = (s: string | undefined): s is string => Boolean(s) && s!.length <= MAX_AGENT_ID;
const safeDecode = (s: string): string | undefined => { try { return decodeURIComponent(s); } catch { return undefined; } };

/** Interactive dashboard router. Returns {html} or {redirect}; errors as {error,status}. */
export async function handleDashboardRequest(store: any, method: string, url: URL, body: URLSearchParams, token?: string, principal?: string): Promise<DashboardResult> {
  const path = url.pathname;
  const raw = (k: string) => (body.get(k) ?? "").trim() || undefined;
  // A platform-authenticated user (Databricks Apps) is the actor for every
  // dashboard mutation; form-supplied identities cannot impersonate someone else.
  const IDENTITY_FIELDS = new Set(["agent_id", "from_agent", "me"]);
  const form = (k: string) => principal && IDENTITY_FIELDS.has(k) ? principal : raw(k);
  const me = principal ?? ((url.searchParams.get("me") ?? "").trim() || DEFAULT_OPERATOR);
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
    const cm = path.match(/^\/chat\/([^/]+)$/);
    if (cm) {
      const peer = safeDecode(cm[1]);
      const from = form("me") ?? DEFAULT_OPERATOR;
      const msg = form("body");
      if (!validAgent(peer) || !validAgent(from)) return { error: "invalid agent id", status: 400 };
      if (!msg) return { error: "body required", status: 400 };
      if (msg.length > MAX_CHAT_BODY) return { error: "message too long", status: 413 };
      await store.sendMessage(peer, from, msg, form("task_id"));
      return { redirect: `/chat/${encodeURIComponent(peer)}${qs({ me: from === DEFAULT_OPERATOR ? undefined : from }, token)}` };
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
    const html = renderDashboard(data, {
      refreshSeconds: Number(url.searchParams.get("refresh") ?? 15),
      tasks: { query: parseTaskQuery(url), token },
    })
      .replace("<main>", `<main>
<nav><a href="/chat${tok(token)}">chat</a> · <a href="/inbox/${encodeURIComponent(principal ?? DEFAULT_OPERATOR)}${tok(token)}">inbox</a>${principal ? ` · signed in as ${escapeHtml(principal)}` : ""}</nav>`)
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
      .replace("</style>", `a{color:#7dd3fc}input,select,textarea{background:#11151d;color:#d6dae2;border:1px solid #2a3342;padding:6px 8px;font:inherit;border-radius:4px}textarea{width:100%;min-height:60px}button{background:#1d4ed8;color:#fff;border:0;border-radius:4px;padding:6px 14px;font:inherit;cursor:pointer}form.stack{display:flex;flex-direction:column;gap:8px;max-width:640px}form.inline{display:inline}nav{margin-bottom:10px}
${MOBILE_CSS}</style>`);
    return { html };
  }
  if (!validAgent(me)) return { error: "invalid agent id", status: 400 };
  if (path === "/chat" || path === "/chat/") {
    const data = await store.dashboard();
    return { html: renderChatIndex(me, chatPeers(data, me), { token }) };
  }
  if (path === "/chat/open") {
    const peer = (url.searchParams.get("peer") ?? "").trim();
    if (!validAgent(peer)) return { error: "peer required", status: 400 };
    return { redirect: `/chat/${encodeURIComponent(peer)}${qs({ me: me === DEFAULT_OPERATOR ? undefined : me }, token)}` };
  }
  const chat = path.match(/^\/chat\/([^/]+)(\/log)?$/);
  if (chat) {
    const peer = safeDecode(chat[1]);
    if (!validAgent(peer)) return { error: "invalid agent id", status: 400 };
    if (chat[2]) {
      const messages = await store.conversation(me, peer, 200);
      return { html: renderChatLog(me, peer, messages, { token }) };
    }
    return { html: renderChatPage(me, peer, { token, taskId: url.searchParams.get("task") ?? undefined }) };
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
