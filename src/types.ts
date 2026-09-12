export type SearchRole = "user" | "assistant";

export interface SessionScope {
  cwd: string;
  sessionDir: string;
  /** True for a custom session directory, where pi filters by header cwd. */
  filterByCwd: boolean;
}

/** Cheap per-file metadata, enough to render a list row and resume. */
export interface SessionMeta {
  path: string;
  id: string;
  cwd: string;
  /** Display name from the latest session_info entry. */
  name?: string;
  /** First user message, bounded; the row title when there is no name. */
  title: string;
  /** File mtime in unix milliseconds. */
  modified: number;
}

export interface SessionDocument {
  entryId: string;
  role: SearchRole;
  text: string;
}

export type MatchRange = readonly [start: number, end: number];

export interface DocumentMatch {
  document: SessionDocument;
  ranges: MatchRange[];
}

export interface SessionMatch {
  session: SessionMeta;
  matches: DocumentMatch[];
  /** Total match ranges across all matched documents. */
  hitCount: number;
  /** True when the per-file line cap stopped counting early. */
  capped: boolean;
}
