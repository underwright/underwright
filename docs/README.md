# underwright docs

**Control plane for agentic software development.** Agents that underwrite
their work.

Underwright is an MCP control plane that makes *any* coding agents (Claude
Code, Copilot, Codex, Devin, or your own) follow a real SDLC: shared tasks
instead of scattered prompts, claims instead of collisions, evidence instead
of "looks done to me."

## Contents

- [Product requirements & vision](prd.md)
- [Whitepaper](underwright-whitepaper.md)
- [Process flow](process-flow.md)
- [Node daemon](node-daemon.md)
- [Node executors](node-executors.md)
- [Multi-harness](multi-harness.md)
- [TLS reverse proxy](tls-reverse-proxy.md)
- [GitHub webhook](webhook.md)
- [Glossary](glossary.md)
- [Engineering standards](engineering-standards.md)
- [Architecture decision records](adr/)

## Get started

```bash
npm install -g underwright
underwright init
```

See the [GitHub repository](https://github.com/underwright/underwright) for
the full README, agent rules, and development setup.
