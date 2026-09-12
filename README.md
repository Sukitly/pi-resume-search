# pi-resume-search

`/rs`: resume a [pi](https://github.com/earendil-works/pi) session by searching what was said in it, not just its first message.

pi's `/resume` lists each session by its first user message. When the thing you remember was said halfway through a conversation, that list does not help. `/rs` opens the same kind of picker, searches user and assistant messages as you type, shows the matching lines for the selected session, and resumes the one you pick.

## Usage

```
/rs            open the picker with every session in the current project, newest first
/rs <query>    open it with a query already applied
```

- Type to search. The list and the preview update as you type.
- `re:<pattern>` switches to regex mode (ripgrep syntax).
- Matching is case-insensitive unless the query contains an uppercase letter.
- `↑` `↓` move between sessions, `Enter` resumes the selected session, `Esc` cancels.
- The preview shows up to four matching messages of the selected session, labelled `you` or `pi`, with the match aligned in one column.

## What is searched

- The same sessions `/resume` shows for the current folder: the project's session directory. With a custom `--session-dir`, sessions are filtered by the cwd in their header, as pi does.
- User and assistant message text only. Thinking blocks, tool calls, tool results, compaction summaries, and extension messages are never matched.
- Search is read-only. Session files are not modified and nothing is sent anywhere.

There is no index and no cache. Every query runs [ripgrep](https://github.com/BurntSushi/ripgrep) over the session files, so results always reflect the files on disk and nothing stays resident between queries.

Limits: at most 200 matching messages per session (shown as `N+ hits`) and 20 highlighted positions per message.

Regex notes: the first pass runs over the stored JSONL, where quotes, backslashes, and newlines are escaped, so a pattern that spans those characters may miss. Patterns use ripgrep's regex syntax, which has no lookaround or backreferences and cannot be made pathological.

## Requirements

- pi in interactive mode.
- ripgrep (`rg`) on `PATH`, or the copy pi downloads to `~/.pi/agent/bin` for its own grep tool.

## Performance

Measured on a project with 290 sessions totalling 426 MB of JSONL, files already in the OS page cache:

| Action | Time |
| --- | --- |
| Open the picker (list 290 sessions) | ~160 ms |
| `useEffect` (19 sessions, 40 hits) | ~120 ms |
| `数据库` (114 sessions, 487 hits) | ~130 ms |
| `the` (195 sessions, 4517 hits) | ~340 ms |
| `re:use(Effect\|State)` | ~160 ms |

A small project costs about 45 ms per query, almost all of it process start-up. The first query after a reboot is bound by disk speed.

## Install

```sh
pi install git:github.com/Sukitly/pi-resume-search
```

Or try it from a checkout without installing:

```sh
pi -e .
```

## Development

Requires Bun and pi.

```sh
bun install --ignore-scripts
bun run lint      # TypeScript and Biome checks
bun run test      # Vitest; ripgrep-backed tests are skipped when rg is missing
bun run format    # apply Biome fixes
```

Entry point: `extensions/pi-resume-search.ts`. Implementation in `src/`: `ripgrep.ts` (process handling and output parsing), `sessions.ts` (listing), `search.ts` (query parsing and the two search passes), `ui.ts` (the picker), `command.ts` (registration).

## License

MIT
