import { expect, test } from "@playwright/test";

test("host, seeker, hider, match finish, and published replay", async ({ browser, baseURL }) => {
  const host = await browser.newContext({ geolocation: { latitude: 51.128, longitude: 71.43 }, permissions: ["geolocation"] });
  const hostPage = await host.newPage();
  await hostPage.goto(baseURL!);
  await hostPage.getByRole("button", { name: "Enter local demo" }).click();
  await hostPage.getByRole("button", { name: "Create a hunt" }).click();

  const map = hostPage.getByLabel("Game map");
  const box = await map.boundingBox();
  if (!box) throw new Error("Map did not render");
  await hostPage.mouse.click(box.x + box.width * .25, box.y + box.height * .25);
  await hostPage.mouse.click(box.x + box.width * .75, box.y + box.height * .25);
  await hostPage.mouse.click(box.x + box.width * .75, box.y + box.height * .75);
  await hostPage.mouse.click(box.x + box.width * .25, box.y + box.height * .75);
  await hostPage.getByRole("button", { name: "Continue to game rules" }).click();
  await hostPage.getByRole("button", { name: "Create lobby" }).click();
  await hostPage.getByRole("button", { name: "Open lobby" }).click();
  await hostPage.getByRole("button", { name: "Invite" }).click();
  const inviteCode = await hostPage.locator(".invite-drawer code").innerText();

  const guests = await Promise.all(["Swift Fox", "Night Owl"].map(async (name, index) => {
    const context = await browser.newContext({ geolocation: { latitude: 51.128 + index * .00002, longitude: 71.43 }, permissions: ["geolocation"] });
    const page = await context.newPage();
    await page.goto(`${baseURL}/?invite=${encodeURIComponent(inviteCode)}`);
    await page.getByLabel("Your trail name").fill(name);
    await page.locator('input[type="checkbox"]').nth(0).check();
    await page.locator('input[type="checkbox"]').nth(1).check();
    await page.getByRole("button", { name: "Accept & join lobby" }).click();
    await expect(page.getByText("SPECTATOR", { exact: true })).toBeVisible();
    return { context, page };
  }));

  await hostPage.locator(".invite-drawer .icon-button").click();
  await hostPage.getByRole("button", { name: "☰" }).click();
  await expect(hostPage.getByText("3 players")).toBeVisible();
  await hostPage.getByRole("button", { name: "Auto-balance teams" }).click();
  await hostPage.locator(".drawer .icon-button").click();
  await hostPage.getByRole("button", { name: "Start hunt" }).click();
  await expect(hostPage.getByText("HIDING", { exact: true })).toBeVisible();

  hostPage.once("dialog", (dialog) => dialog.accept());
  await hostPage.getByRole("button", { name: "End" }).click();
  await hostPage.getByRole("button", { name: "View replay" }).click();
  await expect(hostPage.getByText("FULL REPLAY")).toBeVisible();
  await hostPage.getByRole("button", { name: "Publish replay" }).click();

  await guests[0]!.page.goto(`${baseURL}/?replay=${new URL(hostPage.url()).searchParams.get("replay")}`);
  await expect(guests[0]!.page.getByText("FULL REPLAY")).toBeVisible();

  await Promise.all(guests.map(({ context }) => context.close()));
  await host.close();
});
