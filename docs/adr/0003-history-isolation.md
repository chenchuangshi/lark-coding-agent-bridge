# History Isolation for Feishu resume lists

Desktop/plugin default thread lists omit `exec` sessions, so Feishu conversations never appear there. Rather than chase app-server origin changes so Feishu shows up in those UIs, we chose the symmetric product rule: Feishu `/resume` and `/resume archived` pass `sourceKinds: ["exec"]` only. Shared Codex Home stays for Provider Switch; Metadata Interop (L2) stays for Codex-native archive/rename. Hard resume by raw thread id remains possible and is not blocked.

## Considered Options

- **Full separate Codex Home** — isolates history and breaks Provider Switch for Feishu; rejected.
- **Bridge Session Map–only listing** — more “pure Feishu” but empty/lost maps look like data loss; rejected.
- **History Isolation via `exec` filter** — accepted; matches how the bridge creates threads today.
