import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ call: vi.fn(), close: vi.fn(), connect: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class { callTool = mock.call; close = mock.close; connect = mock.connect; } }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {} }));
import { publishCatalog } from "../src/model-refresh.js";
import { diffCatalog } from "../src/model-catalog.js";
const options = { url: "http://localhost/mcp", token: "test", agentId: "catalog@test", recipient: "human" };
beforeEach(() => { vi.clearAllMocks(); mock.call.mockResolvedValue({ content: [] }); });
describe("scheduled publication", () => {
  it("posts a proposal with null tiers and sends triage mail for unassigned models", async () => {
    await publishCatalog([diffCatalog({ harness: "codex", models: ["gpt-new"] })], options);
    const calls = mock.call.mock.calls.map(([arg]) => arg);
    expect(calls.map(c => c.name)).toEqual(["post_artifact", "send_message"]);
    const proposal = JSON.parse(calls[0].arguments.content);
    expect(proposal.review_required).toBe(true);
    expect(proposal.proposed_assignments).toEqual([{ harness: "codex", model: "gpt-new", tier: null }]);
    expect(calls[1].arguments.to).toBe("human");
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it("publishes an unchanged catalog without noisy mail", async () => {
    await publishCatalog([diffCatalog({ harness: "grok", models: ["grok-4"] }, { heavy: "grok-4" })], options);
    expect(mock.call).toHaveBeenCalledTimes(1);
  });
  it("rejects Store errors carried inside successful MCP responses", async () => {
    mock.call.mockResolvedValueOnce({ content: [{ type: "text", text: '{"error":"task not found"}' }] });
    await expect(publishCatalog([], options)).rejects.toThrow("post_artifact failed");
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it("closes on failed publication and does not send mail claiming success", async () => {
    mock.call.mockResolvedValueOnce({ isError: true });
    await expect(publishCatalog([diffCatalog({ harness: "kimi", models: [], error: "missing key" })], options)).rejects.toThrow("post_artifact failed");
    expect(mock.call).toHaveBeenCalledTimes(1);
    expect(mock.close).toHaveBeenCalledOnce();
  });
});
