# PRD — Underwright

Status: draft v0.1 · 2026-11-04

## Problem

Teams running multiple AI coding agents get duplicated work, no shared
state, unverifiable "done" claims, and no process. Agent harnesses multiply
faster than the SDLC around them.

## Product

A control plane — not an agent — that makes any agentic dev follow a real
SDLC: shared task registry, claim/lease coordination, artifact-based
communication, searchable helper index, evidence-gated Definition of Done,
async job queue, append-only audit.

## Users

- Solo devs running 2+ agents across machines/harnesses (today)
- Teams wanting governed multi-agent dev (near term)
- Regulated orgs needing proof-of-process for AI-written code (premium)

## Non-goals

- Not a coding agent, IDE, or model router
- Not a spec language (Spec Kit compatible instead)
- Not GitHub-only — GitLab/ADO/Bitbucket are first-class via adapters

## Success metrics

- Duplicate-work incidents prevented (helper-index hits before writes)
- % completions with full DoD evidence (warn→block ratchet)
- inference-vs-wait ratio (jobs vs in-context time)
- agents concurrently claiming without collision

## Phases

1. OSS core: local SQLite, stdio+HTTP MCP, DoD engine — **done (v0.1)**
2. Team layer: git adapters, GitHub App, CI action, code index
3. Hosted: Postgres/Lakebase control plane, fleet analytics, compliance
