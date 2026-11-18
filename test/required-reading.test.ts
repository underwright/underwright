import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LAUNCH_PROMPT } from "../src/dispatcher.js";
import { buildLaunchSpec, requiredReadingClause } from "../src/node-dispatch.js";
import { getDispatchPolicy, requiredReadingFor, type Policy } from "../src/policy.js";
import { AGENTS_MD } from "../src/init.js";

const base = { taskId: "gh-1", agentId: "claude@h", host: "h", jobId: "job-1", workspace: "ws", harness: "claude" };

describe("gh-164 required reading", () => {
  it("config-field: parses dispatch.required_reading, dropping junk", () => {
    const d = getDispatchPolicy({ dispatch: { required_reading: { "*": ["CONTRIBUTING.md", " ", 3], ws: ["docs/a.md"], bad: "x", empty: [] } } } as unknown as Policy);
    expect(d.required_reading).toEqual({ "*": ["CONTRIBUTING.md"], ws: ["docs/a.md"] });
    expect(getDispatchPolicy({} as Policy).required_reading).toEqual({});
    expect(getDispatchPolicy({ dispatch: { required_reading: ["x"] } } as unknown as Policy).required_reading).toEqual({});
  });

  it("config-field: merges '*' then workspace entries, de-duplicated", () => {
    const rr = { "*": ["CONTRIBUTING.md"], ws: ["docs/a.md", "CONTRIBUTING.md"] };
    expect(requiredReadingFor({ required_reading: rr }, "ws")).toEqual(["CONTRIBUTING.md", "docs/a.md"]);
    expect(requiredReadingFor({ required_reading: rr }, "other")).toEqual(["CONTRIBUTING.md"]);
    expect(requiredReadingFor({}, "ws")).toEqual([]);
  });

  it("prompt-injection: launch prompt chains AGENTS.md to its required-reading list", () => {
    expect(LAUNCH_PROMPT).toMatch(/read AGENTS\.md .*follow its required-reading list/);
    expect(LAUNCH_PROMPT).toContain("{{required_reading}}");
    const withList = buildLaunchSpec({ ...base, requiredReading: ["docs/standards.md", "docs/review-matrix.md"] }).payload.prompt;
    expect(withList).toContain("Required reading for this workspace (read before coding): docs/standards.md, docs/review-matrix.md.");
    expect(withList).not.toContain("{{");
    const without = buildLaunchSpec(base).payload.prompt;
    expect(without).not.toContain("{{");
    expect(without).not.toContain("Required reading for this workspace");
    expect(without).toMatch(/follow its required-reading list/);
    expect(requiredReadingClause(["  ", ""])).toBe("");
  });

  it("populate: repo policy lists existing docs for underwright and AGENTS.md routes to them", () => {
    const policy = JSON.parse(readFileSync(new URL("../underwright.policy.json", import.meta.url), "utf8")) as Policy;
    const docs = requiredReadingFor(getDispatchPolicy(policy), "underwright");
    expect(docs.length).toBeGreaterThan(0);
    const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
    expect(agents).toContain("## Required reading (before coding)");
    for (const doc of docs) {
      expect(() => readFileSync(new URL(`../${doc}`, import.meta.url))).not.toThrow();
      expect(agents).toContain(doc);
    }
    expect(AGENTS_MD).toContain("## Required reading (before coding)");
    expect(getDispatchPolicy(policy).required_reading.kraftina?.length).toBeGreaterThan(0);
  });

  it("onboarding-docs: convention + checklist + audit documented", () => {
    const doc = readFileSync(new URL("../docs/workspace-onboarding.md", import.meta.url), "utf8");
    expect(doc).toMatch(/Onboarding checklist/);
    expect(doc).toMatch(/dispatch\.required_reading/);
    expect(doc).toMatch(/Workspace audit/);
    for (const ws of ["underwright", "kraftina", "omnigent", "aura"]) expect(doc.toLowerCase()).toContain(ws);
  });
});
