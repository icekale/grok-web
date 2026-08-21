# ACP fixtures

Pinned Grok ACP payloads used as the mapper source of truth. New mapper tests should add a fixture file first, then assert against it — do not keep a second inline copy of the same payload.

Rules:

- Terminal tool fixtures must include `run_terminal_command`, not only `title: "bash"`. Later `title: Execute \`...\`` updates must not become the canonical name.
- Do not commit full private sessions; shorten commands, paths, stdout, and image data.
- Shapes are cut from real `updates.jsonl`, `session/request_permission`, `session/prompt`, `chat_history.jsonl`, and `signals.json`.
