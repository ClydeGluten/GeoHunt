import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const hostName = "Core Lifecycle Host";
const guestName = "Core Lifecycle Seeker";

function signedInitData(token: string) {
  const parameters = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `core-lifecycle-${Date.now()}`,
    signature: "e2e-placeholder-ed25519-signature",
    user: JSON.stringify({ id: 8_500_001_337, first_name: hostName, username: "core_lifecycle_host" }),
  });
  const check = [...parameters.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  parameters.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return parameters.toString();
}

async function authenticateHost(page: Page, baseURL: string) {
  page.on("pageerror", (error) => console.error(`[host page error] ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[host console] ${message.text()}`);
  });
  await page.goto(baseURL);
  const token = process.env.BOT_TOKEN;
  if (token) {
    const status = await page.evaluate(async (initData) => {
      const response = await fetch("/api/v1/auth/telegram", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initData }),
      });
      return response.status;
    }, signedInitData(token));
    expect(status).toBe(200);
    await page.reload();
    await expect(page.getByRole("button", { name: "Create a hunt" })).toBeVisible({ timeout: 15_000 });
    return;
  }
  await page.getByRole("button", { name: "Enter local demo" }).click();
  await expect(page.getByRole("button", { name: "Create a hunt" })).toBeVisible({ timeout: 15_000 });
}

test("core lifecycle survives missing pre-game geolocation", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const host = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const hostPage = await host.newPage();
  let matchId: string | null = null;
  let guest: Awaited<ReturnType<typeof browser.newContext>> | null = null;

  try {
    await authenticateHost(hostPage, baseURL!);
    await hostPage.getByRole("button", { name: "Create a hunt" }).click();

    const map = hostPage.getByLabel("Game map");
    await expect(map).toBeVisible();
    const box = await map.boundingBox();
    if (!box) throw new Error("Map did not render");
    await hostPage.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await hostPage.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.25);
    await hostPage.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75);
    await hostPage.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
    await hostPage.getByRole("button", { name: "Continue to game rules" }).click();
    await hostPage.getByRole("button", { name: "Create lobby" }).click();

    await expect(hostPage.getByRole("button", { name: "Open lobby" })).toBeVisible();
    matchId = new URL(hostPage.url()).searchParams.get("match");
    expect(matchId).toBeTruthy();
    await hostPage.getByRole("button", { name: "Open lobby" }).click();
    await expect(hostPage.getByRole("button", { name: "Start hunt" })).toBeVisible();

    await hostPage.getByRole("button", { name: "Invite" }).click();
    const inviteCode = await hostPage.locator(".invite-drawer code").innerText();

    guest = await browser.newContext({ viewport: { width: 430, height: 932 } });
    const guestPage = await guest.newPage();
    await guestPage.goto(`${baseURL}/?invite=${encodeURIComponent(inviteCode)}`);
    await guestPage.getByLabel("Your trail name").fill(guestName);
    await guestPage.locator('input[type="checkbox"]').nth(0).check();
    await guestPage.locator('input[type="checkbox"]').nth(1).check();
    await guestPage.getByRole("button", { name: "Accept & join lobby" }).click();
    await expect(guestPage.getByText("SPECTATOR", { exact: true })).toBeVisible();

    await hostPage.locator(".invite-drawer .icon-button").click();
    await hostPage.getByRole("button", { name: "☰" }).click();
    await expect(hostPage.getByText("2 players")).toBeVisible();

    const hostRole = hostPage.getByLabel(`Role for ${hostName}`);
    const guestRole = hostPage.getByLabel(`Role for ${guestName}`);
    await hostRole.selectOption("HIDER");
    await guestRole.selectOption("SEEKER");

    // Both contexts intentionally lack geolocation permission. Pre-game GPS
    // failures must not erase explicit lobby role assignments.
    await hostPage.waitForTimeout(6_000);
    await expect(hostRole).toHaveValue("HIDER");
    await expect(guestRole).toHaveValue("SEEKER");

    await hostPage.locator(".drawer .icon-button").click();
    await hostPage.getByRole("button", { name: "Start hunt" }).click();
    await expect(hostPage.getByText("HIDING", { exact: true })).toBeVisible();

    hostPage.once("dialog", (dialog) => dialog.accept());
    await hostPage.getByRole("button", { name: "End" }).click();
    await expect(hostPage.getByText("FINISHED", { exact: true })).toBeVisible();
  } finally {
    if (matchId) {
      await hostPage.evaluate(async (id) => {
        await fetch(`/api/v1/matches/${id}`, { method: "DELETE", credentials: "include" });
      }, matchId).catch(() => undefined);
    }
    await guest?.close().catch(() => undefined);
    await host.close().catch(() => undefined);
  }
});
