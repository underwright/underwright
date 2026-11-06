# Commercial split

Underwright is open-core. This repository is the open-source core (Apache-2.0): the control plane, MCP surface, coordination primitives, dashboard, and everything needed to run it self-hosted on a single workspace.

Commercial components — hosted control plane, org dashboard and analytics, SSO/RBAC, managed fleet runners, and support — live in the private `underwright-pro` repository and consume this package as a dependency. If you're building something that belongs in the paid tier, it does not go in this repo.

The rule of thumb: what a single agent or small team needs to adopt and trust the system is free; what an organization needs to run it at scale or prove governance is paid.
