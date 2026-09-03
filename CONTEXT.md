# Codex Client Topology

How Feishu bridge, Codex desktop, and the VS Code/Cursor Codex plugin share auth/config on one machine while keeping conversation lists isolated.

## Language

**Shared Codex Home**:
The single directory `~/.codex` used by Feishu bridge (`inheritCodexHome=true`), Codex desktop, and the VS Code/Cursor Codex plugin for auth, config, and rollouts.
_Avoid_: profile codex-home, isolated CODEX_HOME (unless explicitly discussing the opt-out)
_Rule_: Feishu must use Shared Codex Home (`inheritCodexHome=true`) so it consumes the same Provider Switch as desktop and the plugin; clients may need reload/restart/new thread to observe it.

**Provider Switch**:
Changing the active Codex model provider and auth via CC Switch, which rewrites Shared Codex Home `config.toml` / `auth.json` for all clients that inherit that home.
_Avoid_: “换账号” alone when you mean only Feishu or only the plugin

**Rollout**:
Codex’s on-disk transcript for one thread under Shared Codex Home (`sessions/**/rollout-*.jsonl`).
_Avoid_: session file, chat log (when referring to Codex’s native store)

**Bridge Session Map**:
Feishu-side binding of a chat/scope to a Codex thread id (`sessions.json` / catalog / session-meta under the Lark profile). Separate from Rollouts.
_Avoid_: Codex session (when you only mean the Feishu mapping)

**Archived Rollout**:
A Rollout moved under Shared Codex Home `archived_sessions/` (kept on disk, not used as an active resume target).
_Avoid_: deleted session (archiving is not deletion)

**Ghost Thread Binding**:
A Bridge Session Map entry (or in-memory resume target) whose thread id no longer has a matching Rollout in Shared Codex Home.
_Avoid_: “会话丢了” alone when the map still points at a dead id

**History Isolation**:
Feishu `/resume` (active and archived) lists only `source=exec` threads; desktop/plugin default lists are interactive-only (`cli`/`vscode`). Conversation pickers stay mutually hidden while still sharing Shared Codex Home for Provider Switch. Hard resume by raw thread id is not blocked.
_Avoid_: Resume Interop, 会话互通, 全互通
_Rule_: Do not present Feishu and desktop/plugin history as one shared picker.

**Metadata Interop (L2)**:
Archive / unarchive / rename of a Codex thread is performed through Codex app-server RPCs against Shared Codex Home so Feishu and CLI see the same Codex-native archived/name state. Desktop/plugin sidebars are not expected to list Feishu `exec` threads.
_Avoid_: Bridge-only list hide presented as archive; “同步到桌面侧栏” as the success criterion

**Purge**:
Irreversible removal of selected Rollouts from Shared Codex Home (delete on-disk transcript files and corresponding `threads` rows). Distinct from archiving.
_Avoid_: archive, 去掉列表 alone when files/DB rows must go
_Rule_: Stop desktop/plugin Codex app-servers before mutating `state_5.sqlite`; never Purge active threads unless explicitly requested.
