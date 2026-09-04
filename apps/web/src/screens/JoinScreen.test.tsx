import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { JoinScreen } from "./JoinScreen";

describe("guest invite switching", () => {
  it("asks an existing guest to join a different match instead of reusing the old participant", () => {
    vi.stubGlobal("window", {});
    const markup = renderToStaticMarkup(
      <JoinScreen inviteCode="new-invite" existingGuest onJoined={vi.fn()} />,
    );

    expect(markup).toContain("Your trail name");
    expect(markup).toContain("Accept &amp; join lobby");
    expect(markup).not.toContain("Continue to lobby");
  });
});
