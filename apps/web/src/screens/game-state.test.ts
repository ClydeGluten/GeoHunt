import { describe, expect, it } from "vitest";
import { phaseSecondsLeft, taggedParticipantState } from "./game-state.js";

describe("live game client state", () => {
  it("keeps a paused countdown frozen at the pause instant", () => {
    expect(
      phaseSecondsLeft(
        "PAUSED",
        "2026-09-04T12:01:00.000Z",
        "2026-09-04T12:00:40.000Z",
        new Date("2026-09-04T12:10:00.000Z").getTime(),
      ),
    ).toBe(20);
  });

  it("shows converted hiders as active seekers immediately", () => {
    expect(taggedParticipantState("SEEKER")).toEqual({
      role: "SEEKER",
      status: "ACTIVE",
    });
    expect(taggedParticipantState("SPECTATOR")).toEqual({
      role: "SPECTATOR",
      status: "TAGGED",
    });
  });
});
