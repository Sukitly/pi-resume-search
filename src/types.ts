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
  /**
   * Unix milliseconds of the last user or assistant entry, falling back to
   * the header timestamp and then the file mtime, as pi's listing does.
   */
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
  /** Occurrences across all matched messages. Not capped by range storage. */
  hitCount: number;
  /** True when the scan window filled up, so these results are incomplete. */
  capped: boolean;
}
