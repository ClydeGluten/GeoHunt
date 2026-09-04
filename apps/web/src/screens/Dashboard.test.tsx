import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

describe("account controls", () => {
  it("exposes sign-out and permanent data deletion", () => {
    const markup = renderToStaticMarkup(
      <Dashboard
        auth={{
          kind: "WEB",
          account: {
            id: "00000000-0000-4000-8000-000000000001",
            displayName: "Contest Judge",
          },
          participantId: null,
        }}
        inviteCode={null}
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onJoined={vi.fn()}
      />,
    );

    expect(markup).toContain("Sign out");
    expect(markup).toContain("Delete my data");
  });
});
