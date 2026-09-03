# Purge archived Codex rollouts from Shared Codex Home

We needed a clean history after L1 bulk-archive left ~100 Archived Rollouts cluttering desktop/plugin archive views, while only two active threads on `/home/wujie/Chance/test/anyverse` remained useful. We accepted a one-shot **Purge** (delete rollout files + remove archived `threads` rows) over leaving them archived, after stopping desktop/plugin app-servers to avoid SQLite corruption. Active threads were kept. `config.toml` `[projects]` trust was narrowed to that cwd only (including dropping still-present `~/Chance/anyverse`); project directories on disk were not deleted.

Desktop **最近** continued showing ghosts until we also purged derived UI stores: `session_index.jsonl`, `sqlite/codex-dev.db` (`local_thread_catalog`, including a synced `chatgpt:` host catalog), `thread_history_1.sqlite`, and stale thread maps in `.codex-global-state.json`. Future Purges must cover those surfaces, not only `state_5.sqlite` + rollouts.
