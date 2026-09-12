import { spawn } from "node:child_process";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export class RipgrepUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RipgrepUnavailableError";
  }
}

/** rg exited with an error, for example an invalid regex. */
export class RipgrepError extends Error {
  readonly code: number | null;
  readonly stderr: string;

  constructor(code: number | null, stderr: string) {
    super(summarizeStderr(stderr) || `ripgrep exited with ${code}`);
    this.name = "RipgrepError";
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * rg prints multi-line diagnostics such as `rg: regex parse error:` followed
 * by the pattern and a final `error: unclosed group`. Prefer that last line.
 */
function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const detail = lines.find((line) => line.startsWith("error:"));
  const chosen = detail ?? lines[0] ?? "";
  return chosen.replace(/^(?:rg: |error: )/, "");
}

export class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

export interface RipgrepOptions {
  /** Written to rg's stdin; rg searches it when no paths are given. */
  input?: string;
  signal?: AbortSignal;
  /** Executable override, mainly for tests. */
  command?: string;
}

/** Flags shared by every invocation: session directories are under ~/.pi. */
export const RIPGREP_BASE_ARGS = [
  "--no-config",
  "--no-messages",
  "--no-ignore",
  "--hidden",
  "--color",
  "never",
];

/**
 * Candidate executables. pi downloads ripgrep for its own grep tool into
 * `<agentDir>/bin`, so that copy is tried after PATH.
 */
export function ripgrepCandidates(): string[] {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return ["rg", join(getAgentDir(), "bin", `rg${suffix}`)];
}

let resolvedCommand: string | undefined;

/**
 * Runs rg and resolves with stdout. Exit code 1 (no matches) resolves with an
 * empty string; exit code 2 rejects with RipgrepError; a missing executable
 * rejects with RipgrepUnavailableError; an aborted signal rejects with
 * AbortError after killing the process.
 */
export async function runRipgrep(
  args: readonly string[],
  options: RipgrepOptions = {},
): Promise<string> {
  if (options.command) return spawnRipgrep(options.command, args, options);
  const candidates = resolvedCommand ? [resolvedCommand] : ripgrepCandidates();
  let lastError: RipgrepUnavailableError | undefined;
  for (const candidate of candidates) {
    try {
      const output = await spawnRipgrep(candidate, args, options);
      resolvedCommand = candidate;
      return output;
    } catch (error) {
      if (!(error instanceof RipgrepUnavailableError)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new RipgrepUnavailableError("ripgrep (rg) not found");
}

function spawnRipgrep(
  command: string,
  args: readonly string[],
  options: RipgrepOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const child = spawn(command, [...RIPGREP_BASE_ARGS, ...args], {
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill();
      settle(() => reject(new AbortError()));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(() =>
        reject(
          error.code === "ENOENT"
            ? new RipgrepUnavailableError(`ripgrep not found at ${command}`)
            : new RipgrepError(null, error.message),
        ),
      );
    });
    child.once("close", (code) => {
      settle(() => {
        if (code === 0 || code === 1) {
          resolve(Buffer.concat(stdout).toString("utf8"));
        } else {
          reject(
            new RipgrepError(code, Buffer.concat(stderr).toString("utf8")),
          );
        }
      });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // rg may exit before consuming all input; the close handler reports.
      });
      child.stdin.end(options.input);
    }
  });
}

const FILES_PER_INVOCATION = 400;

/** Runs the same rg arguments over files in batches that fit the arg limit. */
export async function runRipgrepOverFiles(
  args: readonly string[],
  files: readonly string[],
  options: RipgrepOptions = {},
): Promise<string> {
  let output = "";
  for (let i = 0; i < files.length; i += FILES_PER_INVOCATION) {
    const batch = files.slice(i, i + FILES_PER_INVOCATION);
    output += await runRipgrep([...args, "--", ...batch], options);
  }
  return output;
}

export interface RipgrepLine {
  path: string;
  lineNumber: number;
  /** Line content or, with -o, the matched fragment. */
  text: string;
}

/**
 * Parses `--with-filename --line-number --null` output, where each record is
 * `path\0lineNumber:text`.
 */
export function parseRipgrepLines(output: string): RipgrepLine[] {
  const lines: RipgrepLine[] = [];
  let start = 0;
  const length = output.length;
  while (start < length) {
    let end = output.indexOf("\n", start);
    if (end === -1) end = length;
    if (end > start) {
      const record =
        output.charCodeAt(end - 1) === 13 /* \r */
          ? output.slice(start, end - 1)
          : output.slice(start, end);
      const nul = record.indexOf("\0");
      const colon = nul === -1 ? -1 : record.indexOf(":", nul + 1);
      if (nul !== -1 && colon !== -1) {
        const lineNumber = Number(record.slice(nul + 1, colon));
        if (Number.isInteger(lineNumber) && lineNumber > 0) {
          lines.push({
            path: record.slice(0, nul),
            lineNumber,
            text: record.slice(colon + 1),
          });
        }
      }
    }
    start = end + 1;
  }
  return lines;
}

export interface RipgrepSubmatch {
  /** Byte offsets within the line. */
  start: number;
  end: number;
}

export interface RipgrepJsonMatch {
  lineNumber: number;
  submatches: RipgrepSubmatch[];
}

/** Parses `--json` output, keeping only match records with text lines. */
export function parseRipgrepJson(output: string): RipgrepJsonMatch[] {
  const matches: RipgrepJsonMatch[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith('{"type":"match"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const data = (record as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;
    const { line_number: lineNumber, submatches } = data as {
      line_number?: unknown;
      submatches?: unknown;
    };
    if (typeof lineNumber !== "number" || !Array.isArray(submatches)) continue;
    const ranges: RipgrepSubmatch[] = [];
    for (const submatch of submatches) {
      if (typeof submatch !== "object" || submatch === null) continue;
      const { start, end } = submatch as { start?: unknown; end?: unknown };
      if (typeof start === "number" && typeof end === "number" && end > start) {
        ranges.push({ start, end });
      }
    }
    matches.push({ lineNumber, submatches: ranges });
  }
  return matches;
}

/**
 * Escapes text for ripgrep's regex syntax. Every ASCII punctuation character
 * may be backslash-escaped except `<` and `>`, which are word-boundary
 * assertions when escaped and literal otherwise.
 */
export function escapeRipgrepRegex(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    const punctuation =
      code >= 33 && code <= 126 && !/[A-Za-z0-9<>]/.test(char);
    out += punctuation ? `\\${char}` : char;
  }
  return out;
}
