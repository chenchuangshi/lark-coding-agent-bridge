---
status: superseded by ADR-0003
---

# Shared Codex Home across Feishu, desktop, and IDE plugin

We need one Provider Switch (CC Switch) on one machine for Feishu bridge, Codex desktop, and the VS Code/Cursor Codex plugin. We accepted **Shared Codex Home** (`~/.codex` with Feishu `inheritCodexHome=true`) over isolated profile `codex-home`, accepting that destructive cleanup must not target Shared Codex Home from the Feishu agent.

Originally this ADR also aimed at Resume Interop (shared conversation pickers). That product goal is superseded by **History Isolation** in ADR-0003; Shared Codex Home remains for auth/config only.
