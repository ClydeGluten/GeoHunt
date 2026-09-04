import { describe, expect, it } from "vitest";
import { matchesForMode } from "./matches.js";

describe("Telegram match menus", () => {
  it("does not build a results keyboard when no match is finished", () => {
    expect(
      matchesForMode(
        [
          { id: "draft", state: "DRAFT" },
          { id: "active", state: "ACTIVE" },
        ],
        "results",
      ),
    ).toEqual([]);
  });

  it("keeps all matches in management mode", () => {
    const matches = [
      { id: "draft", state: "DRAFT" },
      { id: "finished", state: "FINISHED" },
    ];
    expect(matchesForMode(matches, "manage")).toEqual(matches);
  });
});
