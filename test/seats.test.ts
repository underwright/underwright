import { expect, it, describe } from "vitest";
import {
  failoverEnv,
  nextUntriedSeat,
  quotaRowKey,
  seatKeyOfEnv,
  seatNameOf,
  seatRosterFor,
  seatRowsLike,
  triedSeatsOfEnv,
} from "../src/seats.js";

describe("seat helpers", () => {
  it("derives seat names from explicit UW_SEAT or CODEX_HOME basename", () => {
    expect(seatKeyOfEnv({ UW_SEAT: "work" })).toBe("work");
    expect(seatKeyOfEnv({ CODEX_HOME: "/home/alan/.codex-seat-gmail/" })).toBe("gmail");
    expect(seatKeyOfEnv({ UW_SEAT: "  named  " })).toBe("named");
    expect(seatKeyOfEnv({})).toBeNull();
    expect(seatKeyOfEnv(undefined)).toBeNull();
    expect(seatKeyOfEnv({ UW_SEAT: "", CODEX_HOME: "/x/.seat-b" })).toBe("b");
  });

  it("normalizes tried lists across both env keys, paths and bare names", () => {
    const tried = triedSeatsOfEnv({ UW_SEATS_TRIED: "/a/.seat-gmail,work", UW_CODEX_SEATS_TRIED: "gmail,/b/covasant" });
    expect([...tried].sort()).toEqual(["covasant", "gmail", "work"]);
    expect(triedSeatsOfEnv(undefined).size).toBe(0);
  });

  it("resolves the roster from the generic seats map, with codex_seats as the codex fallback", () => {
    const policy = { watch: { seats: { claude: ["/root/.claude-a"], codex: ["/root/.codex-x"] }, codex_seats: ["/home/alan/.codex-seat-gmail", "/home/alan/.codex-seat-covasant"] } };
    expect(seatRosterFor("claude", policy)).toEqual(["/root/.claude-a"]);
    expect(seatRosterFor("codex", policy)).toEqual(["/root/.codex-x"]);
    expect(seatRosterFor("claude", { watch: { codex_seats: ["/x"] } })).toEqual([]);
    expect(seatRosterFor("codex", { watch: { codex_seats: ["/x"] } })).toEqual(["/x"]);
    expect(seatRosterFor("codex", undefined)).toEqual([]);
  });

  it("picks the next untried seat and stops when the roster is spent", () => {
    const roster = ["/home/alan/.codex-seat-gmail", "/home/alan/.codex-seat-covasant"];
    expect(nextUntriedSeat({}, roster)).toBe(roster[0]);
    expect(nextUntriedSeat({ UW_SEATS_TRIED: "gmail" }, roster)).toBe(roster[1]);
    expect(nextUntriedSeat({ UW_CODEX_SEATS_TRIED: "/home/alan/.codex-seat-gmail,covasant" }, roster)).toBeNull();
    expect(nextUntriedSeat({}, [])).toBeNull();
  });

  it("builds failover env that records the dead seat and the seat about to be tried", () => {
    const env = failoverEnv({ CODEX_HOME: "/a/gmail" }, "gmail", "/a/covasant");
    expect(env.CODEX_HOME).toBe("/a/covasant");
    const tried = triedSeatsOfEnv(env);
    expect(tried.has("gmail")).toBe(true);
    expect(tried.has("covasant")).toBe(true);
    // legacy key stays in sync for the wip watch's failover format
    expect(env.UW_CODEX_SEATS_TRIED).toBe(env.UW_SEATS_TRIED);
  });

  it("keys quota rows so seat marks never alias a provider id", () => {
    expect(quotaRowKey("codex", "gmail")).toBe("codex:gmail");
    expect(seatRowsLike("codex")).toBe("codex:%");
    expect(seatNameOf("/")).toBe("/");
  });
});
