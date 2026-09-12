import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionMeta,
  decodeJsonStringPrefix,
  defaultSessionDir,
  listSessions,
  titleFromUserPrefix,
} from "../src/sessions";
import type { SessionScope } from "../src/types";
import {
  assistantLine,
  hasRipgrep,
  header,
  makeTempDir,
  sessionFile,
  sessionInfoLine,
  type TempDir,
  toolResultLine,
  userLine,
} from "./fixtures";

describe("defaultSessionDir", () => {
  it("encodes the cwd like pi does", () => {
    expect(defaultSessionDir("/Users/me/proj", "/Users/me/.pi/agent")).toBe(
      "/Users/me/.pi/agent/sessions/--Users-me-proj--",
    );
  });
});

describe("decodeJsonStringPrefix", () => {
  it("stops at the closing quote and unescapes", () => {
    expect(decodeJsonStringPrefix('a\\"b\\n中"},"rest')).toBe('a"b\n中');
  });

  it("tolerates a cut in the middle of an escape", () => {
    expect(decodeJsonStringPrefix("abc\\")).toBe("abc");
    expect(decodeJsonStringPrefix("abc\\u00")).toBe("abc");
    expect(decodeJsonStringPrefix("abc\\n")).toBe("abc\n");
  });
});

describe("titleFromUserPrefix", () => {
  it("reads string and array content", () => {
    expect(
      titleFromUserPrefix(
        '{"type":"message","message":{"role":"user","content":"hi there"',
      ),
    ).toBe("hi there");
    expect(
      titleFromUserPrefix(
        '{"type":"message","message":{"role":"user","content":[{"type":"image","data":"AAAA"},{"type":"text","text":"after image"}]',
      ),
    ).toBe("after image");
    expect(
      titleFromUserPrefix(
        '{"type":"message","message":{"role":"user","content":[{"type":"image","data":"AAAA"}]',
      ),
    ).toBeUndefined();
  });
});

describe("buildSessionMeta", () => {
  const file = { path: "/s/a.jsonl", mtimeMs: 5 };

  it("requires a header on line 1", () => {
    expect(buildSessionMeta(file, [])).toBeUndefined();
    expect(
      buildSessionMeta(file, [
        { path: file.path, lineNumber: 2, text: header("x", "/p") },
      ]),
    ).toBeUndefined();
  });

  it("uses the latest name and the first user message", () => {
    const meta = buildSessionMeta(file, [
      { path: file.path, lineNumber: 1, text: header("s", "/p") },
      { path: file.path, lineNumber: 3, text: userLine("first  question") },
      { path: file.path, lineNumber: 4, text: sessionInfoLine("old") },
      { path: file.path, lineNumber: 5, text: userLine("second") },
      { path: file.path, lineNumber: 6, text: sessionInfoLine("  new  ") },
    ]);
    expect(meta).toMatchObject({
      id: "s",
      cwd: "/p",
      name: "new",
      title: "first question",
      modified: 5,
    });
  });
});

describe.skipIf(!hasRipgrep())("listSessions", () => {
  let dir: TempDir;
  let scope: SessionScope;

  beforeEach(async () => {
    dir = await makeTempDir();
    scope = { cwd: "/project", sessionDir: dir.path, filterByCwd: false };
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("lists sessions with titles, names, and cwd, newest first", async () => {
    await dir.write(
      "old.jsonl",
      sessionFile([
        header("old", "/project"),
        userLine("old question"),
        assistantLine("answer"),
        sessionInfoLine("Old name"),
      ]),
      1_700_000_000_000,
    );
    await dir.write(
      "new.jsonl",
      sessionFile([
        header("new", "/elsewhere"),
        toolResultLine("noise first"),
        userLine([
          { type: "image", data: "A".repeat(50_000), mimeType: "image/png" },
          { type: "text", text: "with image" },
        ]),
      ]),
      1_700_000_500_000,
    );
    await dir.write(
      "long.jsonl",
      sessionFile([header("long", "/project"), userLine("x".repeat(5000))]),
      1_700_000_100_000,
    );
    await dir.write("empty.jsonl", "", 1_700_000_200_000);
    await dir.write("bad.jsonl", "not a session\n", 1_700_000_200_000);
    await dir.write("notes.txt", "ignored");

    const sessions = await listSessions(scope);
    expect(sessions.map((s) => s.id)).toEqual(["new", "long", "old"]);
    expect(sessions[0]).toMatchObject({
      cwd: "/elsewhere",
      title: "with image",
      modified: 1_700_000_500_000,
    });
    expect(sessions[0]?.name).toBeUndefined();
    expect(sessions[1]?.title.length).toBeLessThanOrEqual(300);
    expect(sessions[2]).toMatchObject({
      name: "Old name",
      title: "old question",
    });

    const filtered = await listSessions({ ...scope, filterByCwd: true });
    expect(filtered.map((s) => s.id)).toEqual(["long", "old"]);
  });

  it("returns an empty list for a missing directory", async () => {
    expect(
      await listSessions({ ...scope, sessionDir: `${dir.path}/missing` }),
    ).toEqual([]);
  });
});
