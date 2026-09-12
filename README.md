# pi-resume-search

`/rs`: a `/resume` picker that shows you *where* a session matched.

pi's `/resume` already searches the full text of every session, but it only ever shows each session's first message, so a hit tells you nothing about why that session matched. `/rs` runs the search over the same sessions and shows the matching messages themselves, with the query highlighted and a hit count per session, then resumes the one you pick.

The two commands differ in three ways:

| | `/resume` | `/rs` |
| --- | --- | --- |
| What a row shows | first message only | first message, hit count, and the matching messages of the selected session |
| Search text | `SessionManager.list()` loads every session's full transcript into `allMessagesText` and keeps it in memory | one ripgrep pass per query, nothing kept between queries |
| Query syntax | fuzzy tokens, `"phrase"` for exact, `re:` as a JavaScript regex always case-insensitive | literal phrase by default, `re:` as a ripgrep regex, both case-sensitive only when the query has uppercase |

`/rs` does not replace `/resume`: scope toggling, threaded sort, delete, and rename live there.

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

- The same sessions `/resume` shows for the current folder: the project's session directory. With a custom `--session-dir`, sessions are filtered by the cwd in their header, as pi does. Rows are ordered by the last user or assistant entry, the same key pi orders `/resume` by.
- User and assistant message text only. Thinking blocks, tool calls, tool results, compaction summaries, and extension messages are never matched.
- Every message in the file, including messages left on branches you navigated away from with `/fork` or `/tree`. Those can match and appear in the preview but will not be in the conversation after you resume. `/resume` searches them too.
- Search is read-only. Session files are not modified and nothing is sent anywhere.

There is no index and no cache. Every query runs [ripgrep](https://github.com/BurntSushi/ripgrep) over the session files, so results always reflect the files on disk and nothing stays resident between queries.

Limits: at most 200 matching lines are examined per session. Sessions that hit that limit are marked `N+ hits` and the header says how many were affected, so incomplete results are never silent. Hit counts are exact within the examined window; only the highlighting is capped, at 20 positions per message.

Regex notes: `re:` patterns use ripgrep's syntax, which has no lookaround or backreferences and cannot be made pathological. Unlike a literal query, a regex is first matched against the stored JSONL line, where quotes, backslashes, and newlines are escaped and thinking blocks and tool-call arguments are still present; matches outside the message text are then discarded. A pattern that spans an escaped character may miss.

## Requirements

- pi in interactive mode.
- ripgrep (`rg`) on `PATH`, or the copy pi downloads to `~/.pi/agent/bin` for its own grep tool.

## Performance

Measured on a project with 290 sessions totalling 426 MB of JSONL, files already in the OS page cache:

| Action | Time |
| --- | --- |
| Open the picker (list 290 sessions) | ~290 ms |
| `useEffect` (19 sessions, 40 hits) | ~120 ms |
| `数据库` (114 sessions, 548 hits) | ~130 ms |
| `the` (196 sessions, 7095 hits) | ~175 ms |
| `re:use(Effect\|State)` | ~175 ms |

A small project costs about 60 ms per query, almost all of it process start-up. The first query after a reboot is bound by disk speed.

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
