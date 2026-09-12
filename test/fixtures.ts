import { spawnSync } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDocument, SessionMeta } from "../src/types";

export function header(
  id: string,
  cwd: string,
  timestamp = "2026-01-01T00:00:00.000Z",
): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd });
}

let counter = 0;

function nextId(): string {
  counter++;
  return counter.toString(16).padStart(8, "0");
}

function entry(message: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message",
    id: nextId(),
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message,
  });
}

export function userLine(content: unknown): string {
  return entry({ role: "user", content, timestamp: 1_700_000_000_000 });
}

export function assistantLine(
  text: string,
  extraBlocks: unknown[] = [],
): string {
  return entry({
    role: "assistant",
    content: [...extraBlocks, { type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {},
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
  });
}

export function toolCallOnlyLine(argumentsText: string): string {
  return entry({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "bash",
        arguments: { command: argumentsText },
      },
    ],
    stopReason: "toolUse",
    timestamp: 1_700_000_000_000,
  });
}

export function toolResultLine(text: string): string {
  return entry({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1_700_000_000_000,
  });
}

export function sessionInfoLine(name: string | undefined): string {
  return JSON.stringify({
    type: "session_info",
    id: nextId(),
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    name,
  });
}

export function sessionFile(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export interface TempDir {
  path: string;
  write(name: string, content: string, mtimeMs?: number): Promise<string>;
  cleanup(): Promise<void>;
}

export async function makeTempDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), "pi-session-search-"));
  return {
    path,
    async write(name, content, mtimeMs) {
      const file = join(path, name);
      await writeFile(file, content, "utf8");
      if (mtimeMs !== undefined) {
        await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
      }
      return file;
    },
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

export function makeDocument(
  role: SessionDocument["role"],
  text: string,
): SessionDocument {
  return { entryId: nextId(), role, text };
}

export function makeSession(
  overrides: Partial<SessionMeta> & { path: string },
): SessionMeta {
  return {
    id: overrides.path,
    cwd: "/project",
    title: "(no messages)",
    modified: 1_700_000_000_000,
    ...overrides,
  };
}

let ripgrepAvailable: boolean | undefined;

export function hasRipgrep(): boolean {
  if (ripgrepAvailable === undefined) {
    const result = spawnSync("rg", ["--version"], { stdio: "ignore" });
    ripgrepAvailable = !result.error && result.status === 0;
  }
  return ripgrepAvailable;
}
