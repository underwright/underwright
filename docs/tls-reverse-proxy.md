# Running `underwright serve --http` Safely Beyond a Trusted LAN

By default, `underwright serve --http <host>:<port>` exposes the Model Context Protocol (MCP) control plane over plaintext HTTP (`src/server.ts`). While plaintext HTTP on loopback (`127.0.0.1`) or an isolated lab VLAN is convenient for local development, running a shared control plane across multiple machines, cloud VMs, or CI runners requires **transport encryption** and **bearer token authentication**.

Without TLS or an encrypted overlay network, the `Authorization: Bearer <UNDERWRIGHT_TOKEN>` header, task descriptions, artifacts, and evidence payloads travel in the clear.

---

## 1. Choosing a Transport Strategy: Reverse Proxy TLS vs. Tailscale

Never expose `underwright serve --http 0.0.0.0:8741` directly to an untrusted network. Instead, bind Underwright to loopback (`127.0.0.1:8741`)—or a private tailnet interface—and place either a TLS-terminating reverse proxy or Tailscale in front of it.

| Dimension | Reverse Proxy TLS (Caddy / Nginx) | Tailscale (WireGuard Mesh / `tailscale serve`) |
|---|---|---|
| **Best for** | Cloud VMs, public/hybrid endpoints, GitHub Actions CI runners, webhooks, or machines that cannot join a tailnet | Multi-machine agent fleets across developer workstations, home labs, and private VMs |
| **Encryption** | TLS 1.2 / 1.3 via Let's Encrypt (ACME) or internal PKI | End-to-end WireGuard encryption (`100.x.y.z`) + optional HTTPS via `tailscale serve` |
| **Network exposure** | Opens TCP port `443` to allowed IPs or the internet | Zero public inbound ports; only authenticated tailnet nodes can connect |
| **Access control** | `UNDERWRIGHT_TOKEN` + optional IP allowlists / mTLS / rate limits | Tailscale ACLs (node/user identity) **plus** `UNDERWRIGHT_TOKEN` (defense in depth) |
| **Operational overhead** | Requires DNS record, port `80`/`443` reachability (or DNS-01 challenge), and proxy config | Install `tailscaled` and authenticate nodes; no public DNS or firewall holes required |

### Rule of Thumb

- **Use Tailscale** when every agent host (e.g., `claude@minipc`, `agy@alandesktop`, `kimi@laptop-2`) is a machine you control and can join to your tailnet.
- **Use Caddy or Nginx with TLS** when external services (such as hosted GitHub Actions runners reporting CI evidence or webhook adapters) must reach `/mcp` over the internet, or when corporate policy requires standard HTTPS on port `443`.

---

## 2. Reverse Proxy TLS Configurations

When using a reverse proxy, always bind Underwright to loopback so only the local proxy can reach the unencrypted port:

```bash
UNDERWRIGHT_TOKEN="<your-token>" \
UNDERWRIGHT_DB="/var/lib/underwright/underwright.db" \
underwright serve --http 127.0.0.1:8741
```

Because `serve --http` uses MCP's `StreamableHTTPServerTransport` (`Accept: application/json, text/event-stream`), your reverse proxy **must not buffer streaming responses** and must pass the `Authorization` header through unmodified.

### Option A: Caddy (Recommended for Automatic TLS)

Caddy automatically provisions and renews Let's Encrypt / ZeroSSL certificates. Place the following in `/etc/caddy/Caddyfile`:

```caddyfile
underwright.example.com {
    # Enforce modern TLS
    tls {
        protocols tls1.2 tls1.3
    }

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        -Server
    }

    # Only expose /mcp and /health
    @allowed path /mcp /health
    handle @allowed {
        reverse_proxy 127.0.0.1:8741 {
            # Disable response buffering for MCP Streamable HTTP / SSE
            flush_interval -1

            # Upstream liveness check against the unauthenticated health endpoint
            health_uri /health
            health_interval 30s
            health_timeout 5s
        }
    }

    handle {
        respond 404
    }
}
```

Reload Caddy after editing:

```bash
sudo systemctl reload caddy
```

### Option B: Nginx

With Nginx and Certbot (or your own certificate/key pair), disable proxy buffering so `text/event-stream` responses from `/mcp` flush immediately. Place the following in `/etc/nginx/conf.d/underwright.conf`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name underwright.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name underwright.example.com;

    ssl_certificate     /etc/letsencrypt/live/underwright.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/underwright.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;

    location = /health {
        proxy_pass http://127.0.0.1:8741/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }

    location = /mcp {
        proxy_pass http://127.0.0.1:8741/mcp;
        proxy_http_version 1.1;

        # Preserve client headers (including Authorization: Bearer <token>)
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # Required for MCP Streamable HTTP / SSE responses
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;

        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        return 404;
    }
}
```

Test and reload Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 3. Tailscale Deployment

If all participating agents run on machines connected to your Tailscale tailnet, you have two ways to expose Underwright safely without opening any public firewall ports:

### Mode 1: Bind Directly to the Tailscale Interface

Find the host's Tailscale IPv4 address (`tailscale ip -4`, e.g., `100.120.201.70`) and bind `serve --http` exclusively to that interface:

```bash
UNDERWRIGHT_TOKEN="<your-token>" \
underwright serve --http 100.120.201.70:8741
```

Traffic between tailnet peers is encrypted end-to-end with WireGuard, and non-tailnet hosts cannot reach `100.120.201.70`. Always still set `UNDERWRIGHT_TOKEN` so compromised or untrusted processes on the tailnet cannot invoke MCP tools without the bearer secret.

### Mode 2: `tailscale serve` (HTTPS on `*.ts.net`)

If an MCP client requires an `https://` URL with a valid browser-trusted certificate, bind Underwright to `127.0.0.1:8741` and let Tailscale terminate TLS inside your tailnet:

```bash
# 1. Run Underwright on loopback
UNDERWRIGHT_TOKEN="<your-token>" underwright serve --http 127.0.0.1:8741

# 2. Expose https://<machine>.<tailnet>.ts.net -> http://127.0.0.1:8741
sudo tailscale serve --bg 8741
```

Agents on your tailnet then configure `"url": "https://<machine>.<tailnet>.ts.net/mcp"`.

---

## 4. Production `systemd` Unit

To run `underwright serve --http` reliably on a Linux host, run it under a dedicated unprivileged user with secrets loaded from a root-owned `EnvironmentFile`.

### 1. Create User, Directories, and Environment File

```bash
sudo useradd --system --home-dir /var/lib/underwright --create-home --shell /usr/sbin/nologin underwright
sudo mkdir -p /etc/underwright
sudo chmod 0750 /etc/underwright

# Generate a 256-bit (32-byte hex) bearer token
TOKEN=$(openssl rand -hex 32)
sudo tee /etc/underwright/underwright.env >/dev/null <<EOF
UNDERWRIGHT_DB=/var/lib/underwright/underwright.db
UNDERWRIGHT_TOKEN=${TOKEN}
EOF

sudo chown root:underwright /etc/underwright/underwright.env
sudo chmod 0640 /etc/underwright/underwright.env
```

### 2. Install `/etc/systemd/system/underwright.service`

```ini
[Unit]
Description=Underwright MCP Control Plane (HTTP)
Documentation=https://github.com/underwright/underwright
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=underwright
Group=underwright
WorkingDirectory=/var/lib/underwright
EnvironmentFile=/etc/underwright/underwright.env

# Bind to loopback when fronting with Caddy/Nginx/tailscale-serve.
# (Or replace 127.0.0.1 with your Tailscale IP if binding directly.)
ExecStart=/usr/bin/node /opt/underwright/dist/cli.js serve --http 127.0.0.1:8741

Restart=on-failure
RestartSec=5s

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/underwright
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
```

### 3. Enable and Verify

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now underwright.service
sudo systemctl status underwright.service
curl -fsS http://127.0.0.1:8741/health
```

---

## 5. `UNDERWRIGHT_TOKEN` Rotation

### How Authentication Works (`src/server.ts`)

When `UNDERWRIGHT_TOKEN` is set in the environment, `serveHttp` checks every request to `/mcp` for an exact header match:

```
Authorization: Bearer <UNDERWRIGHT_TOKEN>
```

Requests missing the header or presenting a stale token receive `401 Unauthorized` with `WWW-Authenticate: Bearer` and body `{"error":"unauthorized"}`.

Because Underwright's HTTP transport is **completely stateless** ([ADR-0001](adr/0001-stateless-http-mcp.md))—creating a fresh `McpServer` and `StreamableHTTPServerTransport` per request and persisting all state in SQLite/Postgres—restarting the server to rotate `UNDERWRIGHT_TOKEN` never drops in-flight task claims, leases, artifacts, or queued jobs.

### Standard Rotation Runbook (Systemd Restart)

1. **Generate a new high-entropy token:**
   ```bash
   NEW_TOKEN=$(openssl rand -hex 32)
   ```
2. **Update `/etc/underwright/underwright.env`:**
   ```bash
   sudo sed -i "s/^UNDERWRIGHT_TOKEN=.*/UNDERWRIGHT_TOKEN=${NEW_TOKEN}/" /etc/underwright/underwright.env
   ```
3. **Restart the service:**
   ```bash
   sudo systemctl restart underwright.service
   ```
4. **Verify rejection of the old token and acceptance of the new token:**
   ```bash
   # Expect HTTP 401
   curl -i -s -X POST https://underwright.example.com/mcp \
     -H "Authorization: Bearer old-token"

   # Expect HTTP 200 with board JSON-RPC response
   curl -s -X POST https://underwright.example.com/mcp \
     -H "Authorization: Bearer ${NEW_TOKEN}" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"board","arguments":{}}}'
   ```
5. **Update client configs:** Distribute `${NEW_TOKEN}` to each agent's `.mcp.json` (or CI secret store):
   ```json
   {
     "mcpServers": {
       "underwright": {
         "type": "http",
         "url": "https://underwright.example.com/mcp",
         "headers": {
           "Authorization": "Bearer <NEW_TOKEN>"
         }
       }
     }
   }
   ```

### Zero-Downtime Dual-Token Rotation (Reverse Proxy Grace Window)

If multiple long-running agents across machines cannot update their `.mcp.json` simultaneously, you can accept both the old and new tokens at the reverse proxy during a short migration window and rewrite valid headers to the backend token:

```nginx
# In nginx http {} block: allow both current and next token during rollout
map $http_authorization $underwright_auth {
    default                         "invalid";
    "Bearer <OLD_TOKEN>"            "Bearer <NEW_TOKEN>";
    "Bearer <NEW_TOKEN>"            "Bearer <NEW_TOKEN>";
}

# Inside location = /mcp:
if ($underwright_auth = "invalid") {
    return 401 '{"error":"unauthorized"}';
}
proxy_set_header Authorization $underwright_auth;
```

Once all agent hosts have migrated to `<NEW_TOKEN>`, remove the `"Bearer <OLD_TOKEN>"` entry and reload Nginx.

---

## 6. Why `/health` Stays Unauthenticated

In `src/server.ts`, bearer authentication is intentionally scoped to `/mcp` while `/health` remains open:

```ts
if (token && req.url === "/mcp") {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { "www-authenticate": "Bearer" }).end('{"error":"unauthorized"}');
    return;
  }
}
// ...
if (req.url === "/health") {
  res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  return;
}
```

Keeping `/health` unauthenticated is a deliberate design choice for three reasons:

1. **Zero-secret health probes for infrastructure:** Reverse proxies (Caddy `health_uri /health`, Nginx upstream checks), container orchestrators (`DOCKERFILE` / Kubernetes liveness probes), `systemd` post-start checks, and uptime monitors need to poll process liveness continuously. Requiring `UNDERWRIGHT_TOKEN` on `/health` would force operators to copy the control-plane bearer token into proxy configs, monitoring agents, and plaintext healthcheck command lines.
2. **No store access or information disclosure:** `/health` returns a constant `{"ok":true}` string without opening the database, running queries, or revealing version strings, task counts, agent IDs, or workspace paths.
3. **Clean fault isolation:** Leaving `/health` open lets operators and post-deploy smoke tests ([`docs/engineering-standards.md`](engineering-standards.md)) immediately distinguish **transport/process failures** (`/health` times out or returns `502 Bad Gateway`) from **authentication failures** (`/health` returns `200 OK`, while `/mcp` returns `401 Unauthorized`).
