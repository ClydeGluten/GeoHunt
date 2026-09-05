import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DemoBanner } from "./DemoBanner";

describe("demo banner", () => {
  it("explains that the players follow predetermined paths", () => {
    const markup = renderToStaticMarkup(<DemoBanner onDismiss={vi.fn()} />);

    expect(markup).toContain("demo match for GeoHunt");
    expect(markup).toContain("predetermined paths");
    expect(markup).toContain("replay");
    expect(markup).toContain("Dismiss demo introduction");
  });
});
