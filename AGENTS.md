# Development Rules

## Collaboration

- Keep answers short and technical. No emojis or filler.
- Answer questions before making changes.
- Present the files, intent, and reason for changes, then wait for approval.
- Read existing files before editing. Verify external APIs against installed types and documentation rather than guessing.

## Project Invariants

- The user-facing command is `/rs` (resume with search), not an Agent-facing tool.
- Follow pi's current-project session scope. Do not scan the entire machine or silently include other projects.
- Search user and assistant message text. Exclude thinking, tool calls, and tool results.
- Literal matching is the default. Regex must be explicit, handle invalid patterns, and account for pathological-pattern responsiveness.
- Group results by session and include matching snippets, not only the first message.
- Resume the selected existing session through pi's supported API. Do not create a replacement session.
- Search is read-only. Do not rewrite session files or send their contents to external services.
- Search runs ripgrep over the session files on every query. No persistent index and no cache that outlives the picker.
- Do not describe planned behavior as implemented in documentation or placeholder UI.

## Tooling and Code Quality

- Use Bun and keep `bun.lock`. Do not introduce other package-manager lockfiles.
- Install dependencies with `bun install --ignore-scripts`. Do not enable lifecycle scripts without approval.
- Keep direct dependencies minimal. Review dependency and lockfile changes like source changes.
- Use strict TypeScript and top-level imports. Avoid `any` and non-erasable TypeScript syntax.
- Keep `extensions/pi-resume-search.ts` focused on registration. Put implementation under `src/` and tests under `test/`.
- After code changes, run `bun run lint`.
- Run `bun run test`. Use Vitest through the package script, not Bun's test runner. ripgrep-backed tests skip when `rg` is missing.
- Use `bun run format` for explicit formatting and lint fixes. Do not weaken checks to make them pass.

## Testing Focus

- Current-project isolation and custom session-directory behavior.
- Message-text extraction, excluded blocks, and session-tree semantics.
- Literal and regex matching, invalid patterns, and responsiveness.
- Session grouping, match snippets, and ordering.
- Empty, malformed, or concurrently updated session files.
- Cancellation and restoring the selected session through supported pi APIs.

## Git

- Never commit or push unless asked.
- Stage explicit paths and inspect the staged diff before committing.
- Do not delete files, use destructive Git commands, or force push.
- Do not overwrite unrelated changes. Stop and ask if they conflict with the task.
