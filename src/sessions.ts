import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  parseRipgrepLines,
  type RipgrepLine,
  type RipgrepOptions,
  runRipgrepOverFiles,
} from "./ripgrep";
import type { SessionMeta, SessionScope } from "./types";

/**
 * Mirrors pi's private getDefaultSessionDirPath(): the per-project session
 * directory under the agent directory. Used to detect a custom --session-dir,
 * which is the only case where pi filters sessions by header cwd.
 */
export function defaultSessionDir(
  cwd: string,
  agentDir: string = getAgentDir(),
): string {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

/** Mirrors pi's sessionCwdMatches(): an empty header cwd never matches. */
export function sessionCwdMatches(headerCwd: string, cwd: string): boolean {
  return headerCwd !== "" && resolve(headerCwd) === resolve(cwd);
}

export interface SessionFile {
  path: string;
  mtimeMs: number;
}

/** Top-level `.jsonl` files in the session directory, like pi's list(). */
export async function listSessionFiles(
  sessionDir: string,
): Promise<SessionFile[]> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return [];
  }
  const files: SessionFile[] = [];
  await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const path = join(sessionDir, name);
        try {
          const info = await stat(path);
          if (info.isFile()) files.push({ path, mtimeMs: info.mtimeMs });
        } catch {
          // Deleted or unreadable while listing.
        }
      }),
  );
  return files;
}

/** Longest first-user-message fragment fetched for a title. */
const TITLE_CHARS = 300;

/** JSON string body of up to TITLE_CHARS characters, opening quote included. */
const STRING_PREFIX = `"(?:[^"\\\\]|\\\\.){0,${TITLE_CHARS}}`;

/**
 * Selects the header line, session_info lines, and the leading text of each
 * user message. Used with `--only-matching --replace` so ripgrep prints only
 * the capture groups: whole lines for the first alternative, and for user
 * messages the entry prefix plus a bounded string body. Leading image blocks
 * are skipped by the pattern and never printed, which matters because pasted
 * screenshots are megabytes of base64.
 */
const METADATA_PATTERN =
  '(^\\{"type":"session(?:_info)?".*)' +
  '|(^\\{"type":"message".{0,200}"message":\\{"role":"user","content":)' +
  `(?:(${STRING_PREFIX})` +
  `|\\[(?:\\{"type":"image",[^}]*\\},?)*\\{"type":"text","text":(${STRING_PREFIX}))`;
// ripgrep expands ${N} groups; an unmatched group expands to nothing.
const METADATA_REPLACEMENT = ["1", "2", "3", "4"]
  .map((group) => `$\{${group}}`)
  .join("");

const USER_CONTENT_MARKER = '"role":"user","content":';
const TEXT_BLOCK_MARKER = '{"type":"text","text":"';
const HEADER_PREFIX = '{"type":"session"';
const SESSION_INFO_PREFIX = '{"type":"session_info"';

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Decodes the leading part of a JSON string body that may have been cut mid
 * way. Stops at the first unescaped quote; drops a trailing partial escape.
 */
export function decodeJsonStringPrefix(body: string): string {
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === '"') {
      end = i;
      break;
    }
  }
  let text = end === -1 ? body : body.slice(0, end);
  if (end === -1) text = text.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

/** Title text from a bounded user-line prefix produced by METADATA_PATTERN. */
export function titleFromUserPrefix(prefix: string): string | undefined {
  const marker = prefix.indexOf(USER_CONTENT_MARKER);
  if (marker === -1) return undefined;
  const content = prefix.slice(marker + USER_CONTENT_MARKER.length);
  if (content.startsWith('"')) return decodeJsonStringPrefix(content.slice(1));
  if (!content.startsWith("[")) return undefined;
  const block = content.indexOf(TEXT_BLOCK_MARKER);
  if (block === -1) return undefined;
  return decodeJsonStringPrefix(
    content.slice(block + TEXT_BLOCK_MARKER.length),
  );
}

function collapse(text: string): string {
  return text.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

interface MetaDraft {
  id?: string;
  cwd: string;
  name?: string;
  title?: string;
}

/** Folds metadata records for one file, in line order. */
export function buildSessionMeta(
  file: SessionFile,
  records: readonly RipgrepLine[],
): SessionMeta | undefined {
  const draft: MetaDraft = { cwd: "" };
  for (const record of records) {
    const line = record.text;
    if (record.lineNumber === 1) {
      const entry = parseJson(line);
      if (!isRecord(entry) || entry.type !== "session") return undefined;
      if (typeof entry.id !== "string") return undefined;
      draft.id = entry.id;
      draft.cwd = typeof entry.cwd === "string" ? entry.cwd : "";
      continue;
    }
    if (line.startsWith(SESSION_INFO_PREFIX)) {
      const entry = parseJson(line);
      if (!isRecord(entry) || entry.type !== "session_info") continue;
      const name = typeof entry.name === "string" ? collapse(entry.name) : "";
      draft.name = name || undefined;
      continue;
    }
    if (draft.title === undefined && !line.startsWith(HEADER_PREFIX)) {
      const title = titleFromUserPrefix(line);
      if (title !== undefined) draft.title = collapse(title);
    }
  }
  if (draft.id === undefined) return undefined;
  return {
    path: file.path,
    id: draft.id,
    cwd: draft.cwd,
    name: draft.name,
    title: draft.title || "(no messages)",
    modified: file.mtimeMs,
  };
}

/**
 * Lists sessions in scope with one ripgrep pass over the directory. Output
 * is bounded to headers, names, and title fragments, so nothing else is
 * read into memory. Most recently modified first.
 */
export async function listSessions(
  scope: SessionScope,
  options: RipgrepOptions = {},
): Promise<SessionMeta[]> {
  const files = await listSessionFiles(scope.sessionDir);
  if (files.length === 0) return [];
  const output = await runRipgrepOverFiles(
    [
      "--with-filename",
      "--line-number",
      "--null",
      "--only-matching",
      "--replace",
      METADATA_REPLACEMENT,
      "-e",
      METADATA_PATTERN,
    ],
    files.map((file) => file.path),
    options,
  );
  const byPath = new Map<string, RipgrepLine[]>();
  for (const record of parseRipgrepLines(output)) {
    const list = byPath.get(record.path);
    if (list) list.push(record);
    else byPath.set(record.path, [record]);
  }
  const sessions: SessionMeta[] = [];
  for (const file of files) {
    const meta = buildSessionMeta(file, byPath.get(file.path) ?? []);
    if (!meta) continue;
    if (scope.filterByCwd && !sessionCwdMatches(meta.cwd, scope.cwd)) continue;
    sessions.push(meta);
  }
  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}
