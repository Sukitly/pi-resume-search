import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AbortError, RipgrepError } from "../src/ripgrep";
import {
  buildLinePattern,
  buildSnippet,
  byteRangesToCharRanges,
  documentFromLine,
  jsonEscapeText,
  parseQuery,
  searchSessions,
} from "../src/search";
import { listSessions } from "../src/sessions";
import type { SessionMeta, SessionScope } from "../src/types";
import {
  assistantLine,
  hasRipgrep,
  header,
  makeTempDir,
  sessionFile,
  type TempDir,
  toolCallOnlyLine,
  toolResultLine,
  userLine,
} from "./fixtures";

describe("parseQuery", () => {
  it("treats blank input as empty", () => {
    expect(parseQuery("")).toEqual({ kind: "empty" });
    expect(parseQuery("   ")).toEqual({ kind: "empty" });
    expect(parseQuery("re:")).toEqual({ kind: "empty" });
    expect(parseQuery("re:   ")).toEqual({ kind: "empty" });
  });

  it("uses smart case for literal phrases", () => {
    expect(parseQuery(" foo bar ")).toEqual({
      kind: "literal",
      needle: "foo bar",
      caseSensitive: false,
    });
    expect(parseQuery("Foo")).toMatchObject({ caseSensitive: true });
    expect(parseQuery("数据库")).toMatchObject({ caseSensitive: false });
  });

  it("parses re: patterns and ignores escapes for case detection", () => {
    expect(parseQuery("re:a+b")).toEqual({
      kind: "regex",
      source: "a+b",
      caseSensitive: false,
    });
    expect(parseQuery("re:\\S+")).toMatchObject({ caseSensitive: false });
    expect(parseQuery("re:Foo")).toMatchObject({ caseSensitive: true });
  });
});

describe("buildLinePattern", () => {
  it("JSON-escapes and regex-escapes literal needles", () => {
    expect(jsonEscapeText('say "hi"\\n')).toBe('say \\"hi\\"\\\\n');
    const pattern = buildLinePattern({
      kind: "literal",
      needle: 'a.b "c"',
      caseSensitive: false,
    });
    expect(pattern.endsWith('a\\.b \\\\\\"c\\\\\\"')).toBe(true);
    expect(pattern.startsWith('^\\{"type":"message"')).toBe(true);
  });

  it("wraps regex sources in a group", () => {
    const pattern = buildLinePattern({
      kind: "regex",
      source: "a|b",
      caseSensitive: false,
    });
    expect(pattern.endsWith("(?:a|b)")).toBe(true);
  });
});

describe("documentFromLine", () => {
  it("extracts text blocks and ignores other roles and blocks", () => {
    expect(documentFromLine(userLine("hi"))).toMatchObject({
      role: "user",
      text: "hi",
    });
    expect(
      documentFromLine(
        assistantLine("visible", [
          { type: "thinking", thinking: "hidden" },
          { type: "toolCall", id: "c", name: "read", arguments: {} },
        ]),
      )?.text,
    ).toBe("visible");
    expect(documentFromLine(toolResultLine("x"))).toBeUndefined();
    expect(documentFromLine(toolCallOnlyLine("x"))).toBeUndefined();
    expect(documentFromLine("{broken")).toBeUndefined();
  });
});

describe("byteRangesToCharRanges", () => {
  it("maps UTF-8 byte offsets to string indices", () => {
    const text = "héllo 数据库 x";
    const bytes = Buffer.from(text, "utf8");
    const start = bytes.indexOf(Buffer.from("数据库"));
    expect(
      byteRangesToCharRanges(text, [
        { start, end: start + 9 },
        { start: 0, end: 1 },
        { start: 5, end: 3 },
      ]),
    ).toEqual([
      [6, 9],
      [0, 1],
    ]);
  });
});

describe("buildSnippet", () => {
  it("returns single-line context with clipping flags", () => {
    const text = "line one\n\n  line two has the   match here\nline three";
    const start = text.indexOf("match");
    expect(buildSnippet(text, [start, start + 5], 12, 6)).toEqual({
      before: "o has the ",
      match: "match",
      after: " here",
      clippedStart: true,
      clippedEnd: true,
    });
  });
});

describe.skipIf(!hasRipgrep())("searchSessions", () => {
  let dir: TempDir;
  let scope: SessionScope;
  let sessions: SessionMeta[];

  beforeEach(async () => {
    dir = await makeTempDir();
    scope = { cwd: "/project", sessionDir: dir.path, filterByCwd: false };
    await dir.write(
      "recent.jsonl",
      sessionFile([
        header("recent", "/project"),
        userLine('please fix the useEffect loop in "app.tsx"'),
        assistantLine("The useEffect dependency array is wrong. USEEFFECT!", [
          { type: "thinking", thinking: "useEffect thinking only" },
        ]),
        toolCallOnlyLine("grep useEffect src"),
        toolResultLine("useEffect appears in tool output"),
        userLine("数据库 迁移 how"),
      ]),
      1_700_000_500_000,
    );
    await dir.write(
      "old.jsonl",
      sessionFile([
        header("old", "/project"),
        userLine("nothing relevant\nline two mentions useeffect"),
        assistantLine("a.b literal and axb"),
      ]),
      1_700_000_000_000,
    );
    sessions = await listSessions(scope);
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("finds literal matches in user and assistant text only", async () => {
    const results = await searchSessions(
      { kind: "literal", needle: "useeffect", caseSensitive: false },
      { sessions },
    );
    expect(results.map((r) => r.session.id)).toEqual(["recent", "old"]);
    const recent = results[0];
    expect(recent?.hitCount).toBe(3);
    expect(
      recent?.matches.map((m) => [m.document.role, m.ranges.length]),
    ).toEqual([
      ["user", 1],
      ["assistant", 2],
    ]);
    const joined = recent?.matches.map((m) => m.document.text).join("\n");
    expect(joined).not.toContain("thinking only");
    expect(joined).not.toContain("tool output");
    expect(results[1]?.matches[0]?.ranges).toEqual([[35, 44]]);
  });

  it("respects smart case", async () => {
    const results = await searchSessions(
      { kind: "literal", needle: "USEEFFECT", caseSensitive: true },
      { sessions },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.hitCount).toBe(1);
  });

  it("treats literal needles literally, including quotes", async () => {
    const dot = await searchSessions(
      { kind: "literal", needle: "a.b", caseSensitive: false },
      { sessions },
    );
    expect(dot).toHaveLength(1);
    expect(dot[0]?.hitCount).toBe(1);
    const quoted = await searchSessions(
      { kind: "literal", needle: '"app.tsx"', caseSensitive: false },
      { sessions },
    );
    expect(quoted).toHaveLength(1);
    expect(quoted[0]?.matches[0]?.ranges).toEqual([[33, 42]]);
  });

  it("returns character ranges for CJK text", async () => {
    const results = await searchSessions(
      { kind: "literal", needle: "迁移", caseSensitive: false },
      { sessions },
    );
    expect(results[0]?.matches[0]?.ranges).toEqual([[4, 6]]);
  });

  it("supports regex mode and reports invalid patterns", async () => {
    const results = await searchSessions(
      { kind: "regex", source: "use(effect|state)", caseSensitive: false },
      { sessions },
    );
    expect(results.map((r) => r.session.id)).toEqual(["recent", "old"]);
    await expect(
      searchSessions(
        { kind: "regex", source: "(unclosed", caseSensitive: false },
        { sessions },
      ),
    ).rejects.toBeInstanceOf(RipgrepError);
  });

  it("returns nothing for empty queries or no matches", async () => {
    expect(await searchSessions({ kind: "empty" }, { sessions })).toEqual([]);
    expect(
      await searchSessions(
        { kind: "literal", needle: "zzzz", caseSensitive: false },
        { sessions },
      ),
    ).toEqual([]);
  });

  it("can be aborted", async () => {
    const controller = new AbortController();
    const pending = searchSessions(
      { kind: "literal", needle: "use", caseSensitive: false },
      { sessions, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });
});
