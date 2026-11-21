# Commercial split

Underwright is open-core. This repository is the open-source core (Apache-2.0): the control plane, MCP surface, coordination primitives, dashboard, and everything needed to run it self-hosted on a single workspace.

Commercial components — hosted control plane, org dashboard and analytics, SSO/RBAC, managed fleet runners, HA/failover, and support — live in the private `underwright-pro` repository and consume this package as a dependency. If you're building something that belongs in the paid tier, it does not go in this repo.

The concrete split — repo shape, feature-level (not code-location-level) gating, the tier roster, the declared public surface (`exports` map: `.`, `./istore`, `./schema`), and the version-skew policy — is decided in [ADR-0015](docs/adr/0015-pro-oss-build-split.md). Notably `PgStore` stays OSS: the premium boundary is features, not where a store class happens to live.

The rule of thumb: what a single agent or small team needs to adopt and trust the system is free; what an organization needs to run it at scale or prove governance is paid.
