import { afterEach, describe, expect, it, vi } from "vitest";
import { diffCatalog, parseCatalog, probeCatalog, refreshCatalog } from "../src/model-catalog.js";

describe("catalog parsing", () => {
  it("reads API, Codex and CLI JSON formats with stable deduplication", () => {
    expect(parseCatalog('{"data":[{"id":"claude-sonnet-4"},{"id":"claude-sonnet-4"}]}')).toEqual(["claude-sonnet-4"]);
    expect(parseCatalog('{"data":[{"id":"gpt-5","model":"gpt-5"}]}')).toEqual(["gpt-5"]);
    expect(parseCatalog('{"models":["kimi-k2","grok-4"]}')).toEqual(["grok-4", "kimi-k2"]);
  });
  it("reads noninteractive lists and strips terminal formatting", () => {
    expect(parseCatalog('\u001b[32m* grok-4\u001b[0m  Grok 4\ncomposer-2 (default)\nAvailable models:')).toEqual(["composer-2", "grok-4"]);
  });
  it("reads current Cursor and Grok listings without dropping unfamiliar model families", () => {
    expect(parseCatalog("Available models\n\nauto - Auto (default)\ngemini-3.1-pro - Gemini 3.1 Pro\ncursor-grok-4.6-high - Grok 4.6\nglm-5.2-max - GLM 5.2 Max\nTip: use --model <id> to switch."))
      .toEqual(["auto", "cursor-grok-4.6-high", "gemini-3.1-pro", "glm-5.2-max"]);
    expect(parseCatalog("Available models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6"))
      .toEqual(["grok-4.6", "grok-4.7", "grok-4.7-build-fast"]);
  });
  it("rejects help text, empty and malformed output", () => {
    for (const output of ["Usage: cmdc [options]\n--model <model>", "{bad", '{"data":[]}', "Authentication required"]) {
      expect(() => parseCatalog(output)).toThrow();
    }
  });
});

describe("proposal-only reconciliation", () => {
  it("deduplicates tier aliases, detects removals and leaves all additions unassigned", () => {
    const table = { light: "gpt-old", standard: "gpt-current", heavy: "gpt-current" };
    const original = JSON.stringify(table);
    expect(diffCatalog({ harness: "codex", models: ["gpt-current", "gpt-new"] }, table)).toMatchObject({
      added: ["gpt-new"], removed: ["gpt-old"], unassigned: ["gpt-new"],
    });
    expect(JSON.stringify(table)).toBe(original);
  });
  it("never infers removals or additions from failed discovery", () => {
    expect(diffCatalog({ harness: "kimi", models: [], error: "missing credentials" }, { heavy: "kimi-k2" })).toMatchObject({ added: [], removed: [], unassigned: [] });
  });
  it("excludes adaptive Devin and rejects unknown harnesses", async () => {
    expect(await refreshCatalog({}, "devin")).toEqual([{ harness: "devin", models: ["adaptive"], excluded: true, added: [], removed: [], unassigned: [] }]);
    await expect(refreshCatalog({}, "invalid")).rejects.toThrow("unknown harness");
  });
});

// API discovery must finish every page before it can establish removals.
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("collects Anthropic pages and sends authentication only to its catalog", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "claude-b" }], has_more: false })));
  vi.stubGlobal("fetch", fetchMock);
  expect(await probeCatalog("claude")).toEqual({ harness: "claude", models: ["claude-a", "claude-b"] });
  expect(String(fetchMock.mock.calls[1][0])).toBe("https://api.anthropic.com/v1/models?after_id=claude-a");
});
it("discards a partial catalog if a later page fails", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" })))
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 })));
  const result = await probeCatalog("claude");
  expect(result.models).toEqual([]);
  expect(diffCatalog(result, { standard: "claude-old" }).removed).toEqual([]);
});
it("reports missing API credentials without publishing secret error details", async () => {
  vi.stubEnv("KIMI_API_KEY", "");
  expect(await probeCatalog("kimi")).toMatchObject({ models: [], error: "missing KIMI_API_KEY; catalog unavailable" });
});

it("preserves Claude Code family selectors when API catalogs list concrete versions", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4" }] }))));
  const result = await probeCatalog("claude");
  expect(result.models).toEqual(["claude-sonnet-4", "sonnet"]);
  expect(diffCatalog(result, { standard: "sonnet" }).removed).toEqual([]);
});
