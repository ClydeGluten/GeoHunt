import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { changePulse, getPulseRule, HostConsent } from "./CreateScreen";

const rules = [
  {
    observerRole: "HIDER",
    targetRole: "HIDER",
    mode: "ALWAYS",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 0,
    persistLastSeen: true,
  },
  {
    observerRole: "SEEKER",
    targetRole: "SEEKER",
    mode: "ALWAYS",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 0,
    persistLastSeen: true,
  },
  {
    observerRole: "SEEKER",
    targetRole: "HIDER",
    mode: "PULSE",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 0,
    persistLastSeen: true,
  },
] as const;

describe("hunter reveal settings", () => {
  it("reads and changes only the seeker-to-hider pulse", () => {
    expect(getPulseRule([...rules], "SEEKER")).toBe(rules[2]);
    const changed = changePulse([...rules], "SEEKER", 15, 90);
    expect(changed[1]).toEqual(rules[1]);
    expect(changed[2]).toMatchObject({
      visibleDurationSeconds: 15,
      cyclePeriodSeconds: 90,
    });
  });
});

describe("host consent", () => {
  it("shows separate location and replay agreements", () => {
    const markup = renderToStaticMarkup(
      HostConsent({
        location: false,
        replay: false,
        onLocationChange: vi.fn(),
        onReplayChange: vi.fn(),
      }),
    );

    expect(markup).toContain("Record my location while I play");
    expect(markup).toContain("Store my route for the match replay");
  });
});
