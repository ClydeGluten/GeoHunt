import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReplayExportLink } from "./ReplayExportLink";

describe("replay export", () => {
  it("offers the host a download from the replay export endpoint", () => {
    const markup = renderToStaticMarkup(
      <ReplayExportLink matchId="00000000-0000-4000-8000-000000000001" />,
    );

    expect(markup).toContain("Export replay");
    expect(markup).toContain(
      'href="/api/v1/matches/00000000-0000-4000-8000-000000000001/export"',
    );
    expect(markup).toContain('download=""');
  });
});
