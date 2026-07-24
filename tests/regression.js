const { test, expect } = require('@playwright/test');

test('example test', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toContainText('example);
});

test('new test', async ({ page }) => {
  await page.goto('https://example.com/newpage');
  await expect(page).toContainText('new page');
});