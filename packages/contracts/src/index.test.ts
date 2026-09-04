import { describe, expect, it } from "vitest";
import { CreateMatchSchema, PolygonSchema } from "./index.js";

const match = {
  name: "Consent test",
  playzone: {
    type: "Polygon" as const,
    coordinates: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [0, 0],
      ],
    ],
  },
  settings: {
    durationSeconds: 3600,
    hideSeconds: 300,
    tapTagEnabled: true,
    autoTagEnabled: false,
    tagRadiusMeters: 15,
    autoTagDwellSeconds: 5,
    tagCooldownSeconds: 5,
    positionMaxAgeSeconds: 15,
    maxAccuracyMeters: 50,
    maxSpeedMps: 15,
    caughtBehavior: "SPECTATOR" as const,
    boundaryGraceSeconds: 30,
    boundaryAudience: "HOST" as const,
    boundaryDisqualify: false,
  },
  visibilityRules: [],
};

describe("match creation consent", () => {
  it("requires the host to consent to location recording and replay", () => {
    expect(() => CreateMatchSchema.parse(match)).toThrow();
    expect(
      CreateMatchSchema.parse({
        ...match,
        consentLocation: true,
        consentReplay: true,
      }),
    ).toMatchObject({ consentLocation: true, consentReplay: true });
  });

  it("requires all fields of a Telegram chat grant", () => {
    expect(() =>
      CreateMatchSchema.parse({
        ...match,
        consentLocation: true,
        consentReplay: true,
        telegramChatId: "-100123",
        telegramChatProof: "a".repeat(64),
      }),
    ).toThrow();

    expect(() =>
      CreateMatchSchema.parse({
        ...match,
        consentLocation: true,
        consentReplay: true,
        telegramChatId: "-100123",
        telegramUserId: "42",
        telegramChatProofIssuedAt: 1_788_512_400,
        telegramChatProof: "a".repeat(64),
      }),
    ).not.toThrow();
  });
});

describe("playzone polygons", () => {
  it("requires at least three distinct, non-collinear vertices", () => {
    expect(() =>
      PolygonSchema.parse({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 1],
            [0, 0],
            [0, 0],
          ],
        ],
      }),
    ).toThrow();
    expect(() =>
      PolygonSchema.parse({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 1],
            [2, 2],
            [0, 0],
          ],
        ],
      }),
    ).toThrow();
  });

  it("requires one closed, bounded exterior ring", () => {
    expect(() =>
      PolygonSchema.parse({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
          ],
        ],
      }),
    ).toThrow();
    expect(() =>
      PolygonSchema.parse({
        type: "Polygon",
        coordinates: [
          Array.from({ length: 129 }, (_, index) => [index % 2, index % 3]),
        ],
      }),
    ).toThrow();
    expect(() =>
      PolygonSchema.parse({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
          [
            [0.1, 0.1],
            [0.1, 0.2],
            [0.2, 0.2],
            [0.1, 0.1],
          ],
        ],
      }),
    ).toThrow();
  });
});
