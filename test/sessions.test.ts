import { chmod } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionMeta,
  decodeJsonStringPrefix,
  defaultSessionDir,
  listSessions,
  parseActivityRecord,
} from "../src/sessions";
import type { SessionScope } from "../src/types";
import {
  assistantLine,
  hasRipgrep,
  header,
  makeTempDir,
  sessionFile,
  sessionInfoLine,
  T0,
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

describe("parseActivityRecord", () => {
  it("splits the timestamp from an optional title body", () => {
    expect(parseActivityRecord(`${T0}\t"hello`)).toEqual({
      timestamp: Date.parse(T0),
      title: "hello",
    });
    expect(parseActivityRecord(`${T0}\t`)).toEqual({
      timestamp: Date.parse(T0),
    });
  });

  it("rejects records without a tab or with an unparsable time", () => {
    expect(parseActivityRecord(T0)).toBeUndefined();
    expect(parseActivityRecord("not a date\t")).toBeUndefined();
  });
});

describe("buildSessionMeta", () => {
  const file = { path: "/s/a.jsonl", mtimeMs: 5 };
  const line = (lineNumber: number, text: string) => ({
    path: file.path,
    lineNumber,
    text,
  });

  it("requires a header on line 1", () => {
    expect(buildSessionMeta(file, [])).toBeUndefined();
    expect(
      buildSessionMeta(file, [line(2, header("x", "/p"))]),
    ).toBeUndefined();
  });

  it("takes the title from the first user message only", () => {
    const meta = buildSessionMeta(file, [
      line(1, header("s", "/p")),
      line(3, `${T0}\t"first  question`),
      line(4, `${T0}\t"second`),
    ]);
    expect(meta?.title).toBe("first question");
  });

  it("falls back to a placeholder when no user text was found", () => {
    const meta = buildSessionMeta(file, [
      line(1, header("s", "/p")),
      line(2, `${T0}\t`),
    ]);
    expect(meta?.title).toBe("(no messages)");
  });

  it("keeps the latest name, including an explicit clear", () => {
    const named = buildSessionMeta(file, [
      line(1, header("s", "/p")),
      line(2, sessionInfoLine("old")),
      line(3, sessionInfoLine("  new  ")),
    ]);
    expect(named?.name).toBe("new");
    const cleared = buildSessionMeta(file, [
      line(1, header("s", "/p")),
      line(2, sessionInfoLine("old")),
      line(3, sessionInfoLine("")),
    ]);
    expect(cleared?.name).toBeUndefined();
  });

  it("uses the last entry timestamp, then the header, then the mtime", () => {
    const activity = buildSessionMeta(file, [
      line(1, header("s", "/p", "2026-01-01T00:00:00.000Z")),
      line(2, "2026-03-01T00:00:00.000Z\t"),
      line(3, "2026-02-01T00:00:00.000Z\t"),
    ]);
    expect(activity?.modified).toBe(Date.parse("2026-03-01T00:00:00.000Z"));

    const headerOnly = buildSessionMeta(file, [
      line(1, header("s", "/p", "2026-01-01T00:00:00.000Z")),
    ]);
    expect(headerOnly?.modified).toBe(Date.parse("2026-01-01T00:00:00.000Z"));

    const noTimes = buildSessionMeta(file, [
      line(
        1,
        JSON.stringify({ type: "session", version: 3, id: "s", cwd: "" }),
      ),
    ]);
    expect(noTimes?.modified).toBe(file.mtimeMs);
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
    await chmod(dir.path, 0o700).catch(() => {});
    await dir.cleanup();
  });

  it("reads the title from string content", async () => {
    await dir.write(
      "a.jsonl",
      sessionFile([header("a", "/project"), userLine("plain question")]),
    );
    const [session] = await listSessions(scope);
    expect(session).toMatchObject({ id: "a", cwd: "/project" });
    expect(session?.title).toBe("plain question");
  });

  it("reads the title past leading image blocks", async () => {
    await dir.write(
      "a.jsonl",
      sessionFile([
        header("a", "/project"),
        userLine([
          { type: "image", data: "A".repeat(50_000), mimeType: "image/png" },
          { type: "text", text: "with image" },
        ]),
      ]),
    );
    const [session] = await listSessions(scope);
    expect(session?.title).toBe("with image");
  });

  it("bounds the title length", async () => {
    await dir.write(
      "a.jsonl",
      sessionFile([header("a", "/project"), userLine("x".repeat(5000))]),
    );
    const [session] = await listSessions(scope);
    expect(session?.title.length).toBeLessThanOrEqual(300);
  });

  it("uses the latest session name, including an explicit clear", async () => {
    await dir.write(
      "named.jsonl",
      sessionFile([
        header("named", "/project"),
        userLine("q"),
        sessionInfoLine("First name"),
        sessionInfoLine("Second name"),
      ]),
    );
    await dir.write(
      "cleared.jsonl",
      sessionFile([
        header("cleared", "/project"),
        userLine("q"),
        sessionInfoLine("Gone"),
        sessionInfoLine(""),
      ]),
    );
    const sessions = await listSessions(scope);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect(byId.get("named")?.name).toBe("Second name");
    expect(byId.get("cleared")?.name).toBeUndefined();
  });

  it("skips files that are not pi sessions", async () => {
    await dir.write("empty.jsonl", "");
    await dir.write("bad.jsonl", "not a session\n");
    await dir.write("notes.txt", "ignored");
    await dir.write(
      "ok.jsonl",
      sessionFile([header("ok", "/project"), userLine("q")]),
    );
    expect((await listSessions(scope)).map((s) => s.id)).toEqual(["ok"]);
  });

  it("orders by last activity, not by file mtime", async () => {
    // Older mtime but newer messages: /resume orders by activity.
    await dir.write(
      "active.jsonl",
      sessionFile([
        header("active", "/project", "2026-01-01T00:00:00.000Z"),
        userLine("q", "2026-05-01T00:00:00.000Z"),
      ]),
      1_600_000_000_000,
    );
    await dir.write(
      "stale.jsonl",
      sessionFile([
        header("stale", "/project", "2026-01-01T00:00:00.000Z"),
        userLine("q", "2026-02-01T00:00:00.000Z"),
      ]),
      1_900_000_000_000,
    );
    const sessions = await listSessions(scope);
    expect(sessions.map((s) => s.id)).toEqual(["active", "stale"]);
    expect(sessions[0]?.modified).toBe(Date.parse("2026-05-01T00:00:00.000Z"));
  });

  it("counts assistant turns and tool results as activity or not, like pi", async () => {
    await dir.write(
      "a.jsonl",
      sessionFile([
        header("a", "/project"),
        userLine("q", "2026-02-01T00:00:00.000Z"),
        assistantLine("answer", [], "2026-03-01T00:00:00.000Z"),
        toolResultLine("output", "2026-04-01T00:00:00.000Z"),
      ]),
    );
    const [session] = await listSessions(scope);
    expect(session?.modified).toBe(Date.parse("2026-03-01T00:00:00.000Z"));
  });

  it("filters by header cwd only for a custom session directory", async () => {
    await dir.write(
      "mine.jsonl",
      sessionFile([header("mine", "/project"), userLine("a")]),
    );
    await dir.write(
      "other.jsonl",
      sessionFile([header("other", "/elsewhere"), userLine("b")]),
    );
    await dir.write(
      "nocwd.jsonl",
      sessionFile([header("nocwd", ""), userLine("c")]),
    );
    expect((await listSessions(scope)).map((s) => s.id).sort()).toEqual([
      "mine",
      "nocwd",
      "other",
    ]);
    expect(
      (await listSessions({ ...scope, filterByCwd: true })).map((s) => s.id),
    ).toEqual(["mine"]);
  });

  it("returns an empty list for a missing directory", async () => {
    expect(
      await listSessions({ ...scope, sessionDir: `${dir.path}/missing` }),
    ).toEqual([]);
  });

  it("reports directories it cannot read instead of showing none", async () => {
    await dir.write(
      "a.jsonl",
      sessionFile([header("a", "/project"), userLine("q")]),
    );
    await chmod(dir.path, 0o000);
    await expect(listSessions(scope)).rejects.toMatchObject({ code: "EACCES" });
  });
});
