# Phone & tablet: mobile board + remote chat

`underwright serve --http` serves an interactive dashboard that also works on a phone
or tablet. There is no app to install and no client JS bundle. The pages are
server-rendered HTML. Below 720px wide, every table collapses into labelled cards.
Tap targets are 44px, and inputs use 16px text so iOS doesn't zoom when you focus one.

| Route | What it does |
|---|---|
| `/board` | Live board (meta refresh every 15s). Tap a task id to open the task. |
| `/task/<id>` | Detail, claim/release, artifacts, evidence. If the task is claimed, links to chat with the holder. |
| `/chat` | Agent picker: claim holders first, then lock/job holders and recent actors. |
| `/chat/<agent>` | Conversation thread plus compose box. Add `?task=<id>` to prefill the task. |
| `/inbox/<agent>` | Raw mailbox. Reading it marks messages read. |
| `/login?token=…` / `/logout` | Start or end a cookie session (see below). |

## Remote chat

Chat runs over the ordinary mailbox, so it needs no new protocol:

- You send as `human` by default. Use `?me=alan@phone` to pick another identity.
  The message lands in the agent's `inbox` like any other `send_message`.
- Agents reply with `send_message(to="human", …)`. This is the same path
  `AGENTS.md` already prescribes for escalations.
- The thread view (`/chat/<agent>/log`) is an iframe that refreshes every 5s,
  so a refresh never wipes the reply you're typing.
- The view is **read-only** (`Store.conversation`). Opening a chat never marks
  the agent's mail as read, so the agent still sees your message on its next `inbox`.
  Your own sent messages show `· unread` until the agent has read them.

## Reaching it from your phone

Keep Underwright on loopback and put an HTTPS front in front of it. See
[tls-reverse-proxy.md](tls-reverse-proxy.md) for the full reasoning.

```bash
export UNDERWRIGHT_TOKEN="$(openssl rand -hex 32)"
underwright serve --http 127.0.0.1:8741
```

**Tailscale (phone on your tailnet):** `tailscale serve --bg 8741`, then open
`https://<host>.<tailnet>.ts.net/login?token=<UNDERWRIGHT_TOKEN>` on the phone.

**Tailscale Funnel (public URL, no tailnet app on the phone):**
`tailscale funnel --bg 8741`. This exposes the server to the internet, so the
token is the only gate. Use a long random token and rotate it if it leaks.

**Caddy:** `board.example.com { reverse_proxy 127.0.0.1:8741 }`. Caddy sets
`X-Forwarded-Proto: https`, so the session cookie gets `Secure`.

### Signing in

Phones can't attach an `Authorization` header to a bookmark. Instead, open
`/login?token=<UNDERWRIGHT_TOKEN>` once. The server answers with a session cookie and
redirects to `/board`, which has no token in the URL:

- `uw_token`, `HttpOnly`, `SameSite=Strict`, 30 days, and `Secure` when the request
  arrived over HTTPS (directly or via `X-Forwarded-Proto: https`).
- `SameSite=Strict` means other sites can't submit the dashboard's forms with
  your cookie (CSRF).
- Bearer headers and `?token=` keep working. Comparisons are constant-time.
- `/logout` clears the cookie. Rotating `UNDERWRIGHT_TOKEN` invalidates every session.

Tip: render the login URL as a QR code on your desktop (`qrencode -t ansiutf8 "https://…/login?token=…"`)
and scan it. Then use "Add to Home Screen" and the board opens full-screen.
