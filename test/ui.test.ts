import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RipgrepError, RipgrepUnavailableError } from "../src/ripgrep";
import type { SessionDocument, SessionMatch, SessionMeta } from "../src/types";
import { formatAge, type SearchFn, SessionSearchView } from "../src/ui";
import { makeDocument, makeSession } from "./fixtures";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

const NOW = 1_700_000_000_000;

const documents = new Map<string, SessionDocument[]>([
  [
    "/s/recent.jsonl",
    [
      makeDocument("user", "please fix the useEffect loop"),
      makeDocument("assistant", "The useEffect dependency array is wrong."),
    ],
  ],
  [
    "/s/middle.jsonl",
    [
      makeDocument("user", "search sessions by keyword"),
      makeDocument("assistant", "Use ripgrep for the scan."),
    ],
  ],
  ["/s/old.jsonl", [makeDocument("user", "another useEffect question")]],
]);

function sessions(): SessionMeta[] {
  return [
    makeSession({
      path: "/s/recent.jsonl",
      name: "Named session",
      title: "please fix the useEffect loop",
      modified: NOW - 60_000,
    }),
    makeSession({
      path: "/s/middle.jsonl",
      title: "search sessions by keyword",
      modified: NOW - 3 * 3_600_000,
    }),
    makeSession({
      path: "/s/old.jsonl",
      title: "another useEffect question",
      modified: NOW - 10 * 86_400_000,
    }),
  ];
}

/** In-memory literal search standing in for the ripgrep-backed one. */
const fakeSearch: SearchFn = async (query, metas) => {
  if (query.kind !== "literal") throw new Error("fake supports literals");
  const needle = query.caseSensitive
    ? query.needle
    : query.needle.toLowerCase();
  const results: SessionMatch[] = [];
  for (const session of metas) {
    const matches = [];
    for (const document of documents.get(session.path) ?? []) {
      const haystack = query.caseSensitive
        ? document.text
        : document.text.toLowerCase();
      const ranges: [number, number][] = [];
      let index = haystack.indexOf(needle);
      while (index !== -1) {
        ranges.push([index, index + needle.length]);
        index = haystack.indexOf(needle, index + needle.length);
      }
      if (ranges.length > 0) matches.push({ document, ranges });
    }
    if (matches.length > 0) {
      const hitCount = matches.reduce((sum, m) => sum + m.ranges.length, 0);
      results.push({ session, matches, hitCount, capped: false });
    }
  }
  return results;
};

interface Harness {
  view: SessionSearchView;
  onSelect: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  type(text: string): void;
  text(width?: number): string;
  settle(): Promise<void>;
}

const views: SessionSearchView[] = [];

function createView(
  options: { initialQuery?: string; search?: SearchFn } = {},
): Harness {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  let pending = 0;
  const search: SearchFn = async (query, metas, signal) => {
    pending++;
    try {
      return await (options.search ?? fakeSearch)(query, metas, signal);
    } finally {
      pending--;
    }
  };
  const view = new SessionSearchView({
    theme: plainTheme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    search,
    initialQuery: options.initialQuery,
    currentSessionPath: "/s/middle.jsonl",
    requestRender: () => {},
    onSelect,
    onCancel,
    now: () => NOW,
    debounceMs: 0,
  });
  views.push(view);
  return {
    view,
    onSelect,
    onCancel,
    type: (text) => {
      for (const char of text) view.handleInput(char);
    },
    text: (width = 100) => view.render(width).join("\n"),
    settle: async () => {
      // Let the (zero) debounce timer fire before waiting for the search.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await vi.waitFor(() => {
        expect(pending).toBe(0);
        expect(view.render(100).join("\n")).not.toContain("Searching…");
      });
    },
  };
}

afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
});

describe("formatAge", () => {
  it("formats ages like the session selector", () => {
    expect(formatAge(NOW, NOW - 10_000)).toBe("now");
    expect(formatAge(NOW, NOW - 5 * 60_000)).toBe("5m");
    expect(formatAge(NOW, NOW - 3 * 3_600_000)).toBe("3h");
    expect(formatAge(NOW, NOW - 2 * 86_400_000)).toBe("2d");
    expect(formatAge(NOW, NOW - 20 * 86_400_000)).toBe("2w");
    expect(formatAge(NOW, NOW - 100 * 86_400_000)).toBe("3mo");
    expect(formatAge(NOW, NOW - 800 * 86_400_000)).toBe("2y");
  });
});

describe("SessionSearchView", () => {
  it("shows loading, then lists every session for an empty query", () => {
    const h = createView();
    expect(h.text()).toContain("Loading…");
    expect(h.text()).toContain("Loading sessions…");
    h.view.setSessions(sessions());
    const rendered = h.text();
    expect(rendered).toContain("Session Search (Current Folder)");
    expect(rendered).toContain("3 sessions");
    expect(h.view.getResults().map((r) => r.session.path)).toEqual([
      "/s/recent.jsonl",
      "/s/middle.jsonl",
      "/s/old.jsonl",
    ]);
    expect(rendered).toMatch(/› Named session\s+1m/);
    expect(rendered).toMatch(/another useEffect question\s+1w/);
    expect(rendered).not.toContain("you ");
    h.view.handleInput(KEY_DOWN);
    h.view.handleInput(KEY_ENTER);
    expect(h.onSelect).toHaveBeenCalledWith("/s/middle.jsonl");
  });

  it("applies the initial query once sessions arrive", async () => {
    const h = createView({ initialQuery: "useeffect" });
    h.view.setSessions(sessions());
    await h.settle();
    const results = h.view.getResults();
    expect(results.map((r) => r.session.path)).toEqual([
      "/s/recent.jsonl",
      "/s/old.jsonl",
    ]);
    expect(results[0]?.hitCount).toBe(2);
    const rendered = h.text();
    expect(rendered).toContain("2/3 sessions · 3 hits");
    expect(rendered).toMatch(/› Named session\s+2 hits\s+1m/);
    expect(rendered).toMatch(/another useEffect question\s+1 hit\s+1w/);
    expect(rendered).toContain("please fix the useEffect loop");
    expect(rendered).toContain("The useEffect dependency array is wrong.");
  });

  it("aligns preview matches to one column", async () => {
    const h = createView({ initialQuery: "useeffect" });
    h.view.setSessions(sessions());
    await h.settle();
    const lines = h.view.render(100);
    const preview = lines.filter((line) => /^ {2} ?(you|pi) {2}/.test(line));
    expect(preview).toHaveLength(2);
    const columns = preview.map((line) => line.indexOf("useEffect"));
    expect(columns[0]).toBe(columns[1]);
  });

  it("narrows results while typing and resets the selection", async () => {
    const h = createView();
    h.view.setSessions(sessions());
    expect(h.view.getResults()).toHaveLength(3);
    h.type("use");
    await h.settle();
    expect(h.view.getResults()).toHaveLength(3);
    h.view.handleInput(KEY_DOWN);
    h.view.handleInput(KEY_DOWN);
    expect(h.view.getSelectedSessionPath()).toBe("/s/old.jsonl");
    h.type("Effect");
    await h.settle();
    expect(h.view.getResults().map((r) => r.session.path)).toEqual([
      "/s/recent.jsonl",
      "/s/old.jsonl",
    ]);
    expect(h.view.getSelectedSessionPath()).toBe("/s/recent.jsonl");
    h.type("zzz");
    await h.settle();
    expect(h.view.getResults()).toHaveLength(0);
    expect(h.text()).toContain("No matches");
  });

  it("navigates with the keyboard and resumes the selected session", async () => {
    const h = createView({ initialQuery: "use" });
    h.view.setSessions(sessions());
    await h.settle();
    h.view.handleInput(KEY_UP);
    expect(h.view.getSelectedSessionPath()).toBe("/s/recent.jsonl");
    h.view.handleInput(KEY_DOWN);
    expect(h.view.getSelectedSessionPath()).toBe("/s/middle.jsonl");
    h.view.handleInput(KEY_ENTER);
    expect(h.onSelect).toHaveBeenCalledWith("/s/middle.jsonl");
    h.view.handleInput(KEY_ENTER);
    h.view.handleInput(KEY_ESCAPE);
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it("cancels with escape and ignores enter before sessions load", () => {
    const h = createView();
    h.view.handleInput(KEY_ENTER);
    expect(h.onSelect).not.toHaveBeenCalled();
    h.view.handleInput(KEY_ESCAPE);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("drops results of superseded searches", async () => {
    let release: (() => void) | undefined;
    const slow: SearchFn = async (query, metas, signal) => {
      if (query.kind === "literal" && query.needle === "use") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        expect(signal.aborted).toBe(true);
      }
      return fakeSearch(query, metas, signal);
    };
    const h = createView({ search: slow });
    h.view.setSessions(sessions());
    h.type("use");
    await vi.waitFor(() => expect(release).toBeDefined());
    h.type("Effect");
    release?.();
    await h.settle();
    expect(h.view.getResults()).toHaveLength(2);
  });

  it("explains search failures", async () => {
    const failing: SearchFn = async (query) => {
      if (query.kind === "regex") {
        throw new RipgrepError(2, "error: unclosed group");
      }
      throw new RipgrepUnavailableError("missing");
    };
    const regex = createView({ search: failing, initialQuery: "re:(" });
    regex.view.setSessions(sessions());
    await regex.settle();
    expect(regex.text()).toContain("Invalid regex: unclosed group");
    expect(regex.view.getResults()).toHaveLength(0);
    const literal = createView({ search: failing, initialQuery: "x" });
    literal.view.setSessions(sessions());
    await literal.settle();
    expect(literal.text()).toContain("ripgrep (rg) is not installed");
  });

  it("surfaces listing failures", () => {
    const h = createView();
    h.view.setLoadError("Failed to list sessions: boom");
    expect(h.text()).toContain("Failed to list sessions: boom");
  });

  it("keeps rendered lines within the width", async () => {
    const h = createView({ initialQuery: "use" });
    h.view.setSessions(sessions());
    await h.settle();
    for (const width of [40, 80]) {
      for (const line of h.view.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
