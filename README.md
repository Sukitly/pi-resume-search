# pi-session-search

Find pi sessions by searching user and assistant message text within the current project, not just the first message.

Scaffold only. Search, the interactive UI, and `/session-search` are not implemented yet.

## Planned behavior

- Use pi's current-project session scope, without scanning other projects.
- Search user and assistant message text, excluding thinking, tool calls, and tool results.
- Match literal keywords by default, with an explicit regex mode and invalid-pattern feedback.
- Group matches by session and show identifying metadata and matching snippets.
- Resume the selected session rather than creating a new one.

The initial implementation will scan project sessions directly, without a persistent index or semantic search.

## Development

Requires Bun and pi.

```sh
bun install --ignore-scripts
bun run lint
bun run format
```

`lint` runs TypeScript and Biome checks without modifying files. `format` applies Biome fixes.

Vitest is configured through `bun run test`. No tests exist yet, so that command currently exits with a no-tests error.

Load the scaffold in pi from this directory:

```sh
pi -e .
```

The entry point is `extensions/pi-session-search.ts`. It currently registers nothing. Put search and UI modules under `src/` and deterministic tests under `test/` as implementation begins.

## License

MIT
