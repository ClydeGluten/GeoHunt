import { describe, expect, it } from "vitest";
import { boundsForCoordinates } from "./map-bounds.js";

describe("map bounds", () => {
  it("centers the camera around supplied game coordinates", () => {
    const bounds = boundsForCoordinates([
      [-74.1, 40.6],
      [-73.8, 40.9],
    ]);

    expect(bounds).not.toBeNull();
    expect(bounds![0][0]).toBeCloseTo(-74.1);
    expect(bounds![0][1]).toBeCloseTo(40.6);
    expect(bounds![1][0]).toBeCloseTo(-73.8);
    expect(bounds![1][1]).toBeCloseTo(40.9);
  });

  it("uses the short span for coordinates across the antimeridian", () => {
    const bounds = boundsForCoordinates([
      [179.5, -10],
      [-179.5, 10],
    ]);

    expect(bounds).not.toBeNull();
    expect(bounds![1][0] - bounds![0][0]).toBe(1);
  });
});
