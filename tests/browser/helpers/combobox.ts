import { expect, type Page } from "@playwright/test";

/** Choose a token in a src/ui/combobox.ts field: type to filter, then click the matching row. */
export async function pickToken(page: Page, id: string, query: string, name: string | RegExp) {
  await page.locator(`#${id}`).fill(query);
  await page.locator(`#${id}-list`).getByRole("option", typeof name === "string" ? { name, exact: true } : { name }).click();
  await expect(page.locator(`#${id}`)).toHaveAttribute("aria-expanded", "false");
}

/** Open a combobox without filtering and return its listbox rows. */
export async function openList(page: Page, id: string) {
  await page.locator(`#${id}`).click();
  await expect(page.locator(`#${id}`)).toHaveAttribute("aria-expanded", "true");
  return page.locator(`#${id}-list [role="option"]`);
}
