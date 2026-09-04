import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserLogin } from "./BrowserLogin";

describe("browser login", () => {
  it("offers non-Telegram visitors a host sign-in form", () => {
    const markup = renderToStaticMarkup(
      <BrowserLogin onReady={vi.fn().mockResolvedValue(undefined)} />,
    );

    expect(markup).toContain("Your trail name");
    expect(markup).toContain("Continue in browser");
  });
});
