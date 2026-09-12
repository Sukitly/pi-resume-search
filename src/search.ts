import {
  escapeRipgrepRegex,
  parseRipgrepJson,
  parseRipgrepLines,
  type RipgrepOptions,
  runRipgrep,
  runRipgrepOverFiles,
} from "./ripgrep";
import type {
  DocumentMatch,
  MatchRange,
  SessionDocument,
  SessionMatch,
  SessionMeta,
} from "./types";

export const REGEX_PREFIX = "re:";

export type ParsedQuery =
  | { kind: "empty" }
  | { kind: "literal"; needle: string; caseSensitive: boolean }
  | { kind: "regex"; source: string; caseSensitive: boolean };

const UPPERCASE = /\p{Lu}/u;

/**
 * `re:<pattern>` selects regex mode (ripgrep syntax); anything else is a
 * literal phrase. Smart case: a query without uppercase letters is
 * case-insensitive. Literal queries are trimmed so trailing spaces while
 * typing do not hide results.
 */
export function parseQuery(input: string): ParsedQuery {
  if (input.startsWith(REGEX_PREFIX)) {
    const source = input.slice(REGEX_PREFIX.length);
    if (source.trim() === "") return { kind: "empty" };
    // Ignore escapes such as \S when deciding case sensitivity.
    const caseSensitive = UPPERCASE.test(source.replace(/\\./g, ""));
    return { kind: "regex", source, caseSensitive };
  }
  const needle = input.trim();
  if (needle === "") return { kind: "empty" };
  return { kind: "literal", needle, caseSensitive: UPPERCASE.test(needle) };
}

/** Text as it appears inside a JSON string written by JSON.stringify. */
export function jsonEscapeText(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/**
 * Restricts the file pass to user and assistant message lines. Tool results,
 * compaction entries, and custom messages never reach the JSON parser.
 */
const MESSAGE_LINE_PREFIX =
  '^\\{"type":"message".*"message":\\{"role":"(?:user|assistant)".*';

/**
 * Pattern for the file pass, which runs over raw JSONL. A literal needle is
 * JSON-escaped first so quotes, backslashes, and newlines match how pi
 * stores them. A regex runs against the stored form as written.
 */
export function buildLinePattern(
  query: Exclude<ParsedQuery, { kind: "empty" }>,
): string {
  const body =
    query.kind === "literal"
      ? escapeRipgrepRegex(jsonEscapeText(query.needle))
      : `(?:${query.source})`;
  return MESSAGE_LINE_PREFIX + body;
}

/** Matching lines kept per file before ripgrep stops early. */
export const MAX_LINES_PER_FILE = 200;
/** Ranges kept per message. */
export const MAX_RANGES_PER_DOCUMENT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Parses a matched JSONL line into a searchable document, or undefined. */
export function documentFromLine(line: string): SessionDocument | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || entry.type !== "message") return undefined;
  if (typeof entry.id !== "string") return undefined;
  const message = entry.message;
  if (!isRecord(message)) return undefined;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const text = extractText(message.content);
  if (!text) return undefined;
  return { entryId: entry.id, role, text };
}

/** Converts UTF-8 byte offsets from ripgrep into JS string indices. */
export function byteRangesToCharRanges(
  text: string,
  ranges: readonly { start: number; end: number }[],
): MatchRange[] {
  const bytes = Buffer.from(text, "utf8");
  const result: MatchRange[] = [];
  for (const { start, end } of ranges) {
    if (start < 0 || end > bytes.length || end <= start) continue;
    const charStart = bytes.toString("utf8", 0, start).length;
    const charEnd = charStart + bytes.toString("utf8", start, end).length;
    result.push([charStart, charEnd]);
  }
  return result;
}

export interface SearchOptions extends RipgrepOptions {
  /** Sessions in scope, in display order. Files outside it are ignored. */
  sessions: readonly SessionMeta[];
}

interface Candidate {
  path: string;
  document: SessionDocument;
}

function escapeJsRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Positions of a literal needle; an escaped literal cannot backtrack. */
export function literalRanges(
  text: string,
  needle: string,
  caseSensitive: boolean,
  maxRanges: number,
): MatchRange[] {
  const pattern = new RegExp(
    escapeJsRegExp(needle),
    caseSensitive ? "g" : "gi",
  );
  const ranges: MatchRange[] = [];
  let match = pattern.exec(text);
  while (match !== null && ranges.length < maxRanges) {
    if (match[0].length === 0) break;
    ranges.push([match.index, match.index + match[0].length]);
    match = pattern.exec(text);
  }
  return ranges;
}

/**
 * Finds match positions in decoded texts for a regex query by running it
 * again through ripgrep over stdin, one document per line. Keeps user
 * patterns out of the JavaScript regex engine, which cannot be interrupted.
 */
async function regexRanges(
  texts: readonly string[],
  source: string,
  caseSensitive: boolean,
  options: RipgrepOptions,
): Promise<Map<number, MatchRange[]>> {
  const input = texts.map((text) => text.replace(/[\r\n]/g, " ")).join("\n");
  const output = await runRipgrep(
    ["--json", ...(caseSensitive ? [] : ["--ignore-case"]), "-e", source],
    { ...options, input },
  );
  const byIndex = new Map<number, MatchRange[]>();
  for (const match of parseRipgrepJson(output)) {
    const text = texts[match.lineNumber - 1];
    if (text === undefined) continue;
    const ranges = byteRangesToCharRanges(
      text,
      match.submatches.slice(0, MAX_RANGES_PER_DOCUMENT),
    );
    if (ranges.length > 0) byIndex.set(match.lineNumber - 1, ranges);
  }
  return byIndex;
}

/**
 * One ripgrep pass over the session files finds user/assistant lines that
 * contain the query; only those lines are JSON-parsed. Match positions in
 * the decoded text come from JavaScript for literal needles and from a
 * second ripgrep pass for regexes. Lines that only matched inside thinking
 * blocks or tool-call arguments end up with no positions and are dropped.
 */
export async function searchSessions(
  query: ParsedQuery,
  options: SearchOptions,
): Promise<SessionMatch[]> {
  if (query.kind === "empty" || options.sessions.length === 0) return [];
  const output = await runRipgrepOverFiles(
    [
      "--with-filename",
      "--line-number",
      "--null",
      "--max-count",
      String(MAX_LINES_PER_FILE),
      ...(query.caseSensitive ? [] : ["--ignore-case"]),
      "-e",
      buildLinePattern(query),
    ],
    options.sessions.map((session) => session.path),
    options,
  );

  const candidates: Candidate[] = [];
  const linesPerFile = new Map<string, number>();
  for (const record of parseRipgrepLines(output)) {
    linesPerFile.set(record.path, (linesPerFile.get(record.path) ?? 0) + 1);
    const document = documentFromLine(record.text);
    if (document) candidates.push({ path: record.path, document });
  }
  if (candidates.length === 0) return [];

  let rangesByIndex: Map<number, MatchRange[]>;
  if (query.kind === "literal") {
    rangesByIndex = new Map();
    candidates.forEach((candidate, index) => {
      const ranges = literalRanges(
        candidate.document.text,
        query.needle,
        query.caseSensitive,
        MAX_RANGES_PER_DOCUMENT,
      );
      if (ranges.length > 0) rangesByIndex.set(index, ranges);
    });
  } else {
    rangesByIndex = await regexRanges(
      candidates.map((candidate) => candidate.document.text),
      query.source,
      query.caseSensitive,
      options,
    );
  }

  const byPath = new Map<string, DocumentMatch[]>();
  for (const [index, ranges] of rangesByIndex) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const list = byPath.get(candidate.path);
    const documentMatch = { document: candidate.document, ranges };
    if (list) list.push(documentMatch);
    else byPath.set(candidate.path, [documentMatch]);
  }

  const results: SessionMatch[] = [];
  for (const session of options.sessions) {
    const matches = byPath.get(session.path);
    if (!matches) continue;
    results.push({
      session,
      matches,
      hitCount: matches.reduce((sum, match) => sum + match.ranges.length, 0),
      capped: (linesPerFile.get(session.path) ?? 0) >= MAX_LINES_PER_FILE,
    });
  }
  return results;
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
  clippedStart: boolean;
  clippedEnd: boolean;
}

const WHITESPACE = /[\s\p{Cc}]+/gu;

function flatten(text: string): string {
  return text.replace(WHITESPACE, " ");
}

/** Extracts single-line context around a match for preview rendering. */
export function buildSnippet(
  text: string,
  range: MatchRange,
  contextBefore: number,
  contextAfter: number,
): Snippet {
  const [start, end] = range;
  const windowStart = Math.max(0, start - contextBefore);
  const windowEnd = Math.min(text.length, end + contextAfter);
  return {
    before: flatten(text.slice(windowStart, start)).trimStart(),
    match: flatten(text.slice(start, end)),
    after: flatten(text.slice(end, windowEnd)).trimEnd(),
    clippedStart: windowStart > 0,
    clippedEnd: windowEnd < text.length,
  };
}
