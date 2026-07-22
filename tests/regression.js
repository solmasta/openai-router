/* Regression smoke test for index.html - run before every commit that
   touches app logic. Requires a local static server on :8899 serving the
   repo root (e.g. `npx http-server . -p 8899`) and Playwright with a
   Chromium build available. Exits non-zero on any failed assertion.

   Covers the flows that have actually broken in this app before:
   - basic send + Overseer status bar
   - a send error keeping the message in history (Regen stays usable,
     tabs/storage don't silently lose the message)
   - vision model auto-switch on image attach, and auto-restore after
   - memory add/delete
   - tab creation, per-tab isolation, and switching back
   - profile creation and data isolation

   Run: NODE_PATH=/opt/node22/lib/node_modules node tests/regression.js
*/
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE_URL = process.env.REGRESSION_BASE_URL || 'http://localhost:8899/index.html';
const CHROMIUM_PATH = process.env.REGRESSION_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  OK  ${label}`);
  } else {
    console.log(`FAIL  ${label}`);
    failures++;
  }
}

(async () => {
  const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const imgPath = path.join(os.tmpdir(), 'regression_test.png');
  fs.writeFileSync(imgPath, pngBuf);

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  function isNoise(e) {
    return e.includes('sw.js') || e.includes('ERR_TUNNEL') || e.includes('ERR_CONNECTION_RESET') || e.includes('404');
  }
  function realErrors() { return errors.filter(e => !isNoise(e)); }

  async function waitForSendDone() {
    for (let i = 0; i < 25; i++) {
      const t = await page.textContent('#sendBtn');
      if (t.indexOf('Send') >= 0) return;
      await page.waitForTimeout(300);
    }
  }
  async function dismissConfirmIfAny() {
    const v = await page.evaluate(() => !document.getElementById('agentConfirmModal').classList.contains('hidden'));
    if (v) { await page.click('#agentConfirmSendCurrent'); await page.waitForTimeout(300); }
  }
  async function sendMsg(text) {
    await page.fill('#prompt', text);
    await page.click('#sendBtn');
    await page.waitForTimeout(600);
    await dismissConfirmIfAny();
    await waitForSendDone();
  }

  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 15000 });
  await page.waitForTimeout(1500);

  console.log('\n-- basic send + Overseer bar --');
  await sendMsg('hi there, quick test');
  const barText = await page.evaluate(() => {
    const el = document.getElementById('overseerBarText');
    return el ? el.textContent : null;
  });
  assert(!!barText && barText.length > 0, 'Overseer bar populated after first message');

  console.log('\n-- Overseer suggestion buttons (inline onclick="insertPrompt(...)") actually work --');
  // displayGeneratedPrompts/displayBrainstormingSuggestions build raw HTML
  // strings with onclick="insertPrompt(...)" - inline handlers run in
  // global scope, so this only works if insertPrompt is reachable as
  // window.insertPrompt, not just a function local to the app's IIFE.
  // Build a button with the exact same inline-onclick shape those
  // functions produce, rather than waiting on live Overseer timers.
  await page.evaluate(() => {
    var btn = document.createElement('button');
    btn.id = 'regtestInsertPromptBtn';
    btn.setAttribute('onclick', "insertPrompt('regtest inserted suggestion')");
    document.body.appendChild(btn);
  });
  await page.click('#regtestInsertPromptBtn');
  const insertedPromptValue = await page.inputValue('#prompt');
  assert(insertedPromptValue === 'regtest inserted suggestion', 'tapping a suggestion button (inline onclick="insertPrompt(...)") fills the compose box');
  await page.evaluate(() => {
    document.getElementById('regtestInsertPromptBtn').remove();
    document.getElementById('prompt').value = '';
  });

  console.log('\n-- send error keeps message usable (Regen + tab sync) --');
  // The sandboxed network always fails here (no egress to the worker URLs),
  // which exercises the same catch-block path a real timeout/rate-limit would.
  const chatHasMsg = await page.evaluate(() => document.getElementById('chat').textContent.indexOf('quick test') >= 0);
  assert(chatHasMsg, 'sent message still visible in chat after failed request');
  const regenCount = await page.locator('button:has-text("Regen")').count();
  assert(regenCount >= 1, 'Regen button present after a send error');
  const tabsRaw = await page.evaluate(() => localStorage.getItem('ai_tabs'));
  const tabsHasMsg = !!tabsRaw && tabsRaw.indexOf('quick test') >= 0;
  assert(tabsHasMsg, 'tab storage still contains the message after a send error (not silently dropped)');

  console.log('\n-- vision model auto-switch + auto-restore --');
  const modelBefore = await page.textContent('#modelBtnLabel');
  const fileInput = await page.$('#fileInput');
  await fileInput.setInputFiles(imgPath);
  await page.waitForTimeout(300);
  await sendMsg('what is in this image');
  const modelDuring = await page.textContent('#modelBtnLabel');
  await sendMsg('thanks, tell me more');
  const modelAfter = await page.textContent('#modelBtnLabel');
  assert(modelDuring !== modelBefore, `model switched for image attach (before="${modelBefore}" during="${modelDuring}")`);
  assert(modelAfter === modelBefore, `model restored after image message (before="${modelBefore}" after="${modelAfter}")`);

  console.log('\n-- image attached with no caption still includes a text part --');
  let lastRequestBody = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      try {
        const parsed = JSON.parse(req.postData());
        if (parsed.messages) lastRequestBody = parsed;
      } catch (e) {}
    }
    await route.continue();
  });
  const fileInput2 = await page.$('#fileInput');
  await fileInput2.setInputFiles(imgPath);
  await page.waitForTimeout(300);
  await page.fill('#prompt', '');
  await page.click('#sendBtn');
  await page.waitForTimeout(600);
  await dismissConfirmIfAny();
  await waitForSendDone();
  await page.unroute('**/*');
  const lastUserMsg = lastRequestBody && lastRequestBody.messages ? lastRequestBody.messages.filter(m => m.role === 'user').pop() : null;
  const contentParts = lastUserMsg && Array.isArray(lastUserMsg.content) ? lastUserMsg.content : [];
  const hasTextPart = contentParts.some(p => p.type === 'text');
  assert(hasTextPart, 'a caption-less image attachment still sends a text part alongside the image');

  console.log('\n-- regen reuses the prompt/project active at send time, not whatever is selected now --');
  // A message sent while "Prompt A" is the active system prompt, regenerated
  // after switching to "Prompt B", must still be regenerated under Prompt
  // A's instructions - Regen used to always read whatever's currently
  // selected via getAP(), so switching between send and Regen silently
  // changed which ruleset the model followed (this is what happened when a
  // WORQ project message got regenerated under "Research and Analysis").
  await page.click('#systemToggle'); await page.waitForTimeout(150);
  await page.click('#newPromptBtn'); await page.waitForTimeout(150);
  await page.fill('#promptNameInput', 'Regtest Prompt A');
  await page.fill('#promptContentInput', 'PROJ_A_MARKER instructions');
  await page.click('#savePromptBtn'); await page.waitForTimeout(150);
  await sendMsg('regen prompt-context test');
  await page.click('#systemToggle'); await page.waitForTimeout(150);
  await page.click('#newPromptBtn'); await page.waitForTimeout(150);
  await page.fill('#promptNameInput', 'Regtest Prompt B');
  await page.fill('#promptContentInput', 'PROJ_B_MARKER instructions');
  await page.click('#savePromptBtn'); await page.waitForTimeout(150);
  let lastRegenBody = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      try {
        const parsed = JSON.parse(req.postData());
        if (parsed.messages) lastRegenBody = parsed;
      } catch (e) {}
    }
    await route.continue();
  });
  await page.locator('button:has-text("Regen")').last().click();
  // Poll for the intercepted request body specifically, not just UI
  // settle time - unrouting before the request lands (a race, not an app
  // bug) reads lastRegenBody as null and misreports a failure.
  for (let i = 0; i < 15 && lastRegenBody === null; i++) await page.waitForTimeout(200);
  await dismissConfirmIfAny();
  await waitForSendDone();
  await page.unroute('**/*');
  const regenSysContent = (lastRegenBody && lastRegenBody.messages ? lastRegenBody.messages : [])
    .filter(m => m.role === 'system').map(m => m.content).join('\n');
  assert(regenSysContent.indexOf('PROJ_A_MARKER') >= 0, 'regen uses the prompt active at original send time (Prompt A)');
  assert(regenSysContent.indexOf('PROJ_B_MARKER') < 0, 'regen ignores the prompt switched to afterward (Prompt B)');

  console.log('\n-- github connect/disconnect + write-confirm gate --');
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#githubConnectBtn'); await page.waitForTimeout(150);
  await page.fill('#ghOwnerInput', 'solmasta');
  await page.fill('#ghRepoInput', 'openai-router');
  await page.click('#githubSaveBtn'); await page.waitForTimeout(150);
  const ghStatusAfterConnect = await page.textContent('#githubStatus');
  assert(ghStatusAfterConnect === 'solmasta/openai-router', `GitHub status reflects connected repo (got "${ghStatusAfterConnect}")`);
  const ghPersisted = await page.evaluate(() => localStorage.getItem('gh_repo_owner') === 'solmasta' && localStorage.getItem('gh_repo_name') === 'openai-router');
  assert(ghPersisted, 'GitHub connection persisted to localStorage');

  console.log('\n-- vision model + image request omits repo tools even with GitHub connected --');
  // With GitHub connected, an image sent to a vision model (not in
  // TOOL_MODELS - not vetted for function-calling) must not receive
  // tools/tool_choice: a vision model handed tools could reply via a
  // tool_call instead of plain text, and the streaming reader only reads
  // delta.content, silently producing "(empty response)".
  let lastReqBodyWithTools = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      try {
        const parsed = JSON.parse(req.postData());
        if (parsed.messages) lastReqBodyWithTools = parsed;
      } catch (e) {}
    }
    await route.continue();
  });
  const fileInput3 = await page.$('#fileInput');
  await fileInput3.setInputFiles(imgPath);
  await page.waitForTimeout(300);
  await sendMsg('what is in this image');
  await page.unroute('**/*');
  assert(lastReqBodyWithTools && !lastReqBodyWithTools.tools, 'vision model image request has no tools field with GitHub connected');

  await page.evaluate(() => {
    document.getElementById('ghwPath').textContent = 'test';
    document.getElementById('githubWriteConfirmModal').classList.remove('hidden');
  });
  await page.click('#ghwDenyBtn'); await page.waitForTimeout(150);
  const ghConfirmClosedAfterDeny = await page.evaluate(() => document.getElementById('githubWriteConfirmModal').classList.contains('hidden'));
  assert(ghConfirmClosedAfterDeny, 'write-confirm modal closes on deny (does not hang the tool loop)');
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#githubConnectBtn'); await page.waitForTimeout(150);
  await page.click('#githubDisconnectBtn'); await page.waitForTimeout(150);
  const ghStatusAfterDisconnect = await page.textContent('#githubStatus');
  assert(ghStatusAfterDisconnect === 'Not connected', `GitHub status reflects disconnect (got "${ghStatusAfterDisconnect}")`);

  console.log('\n-- memory add/delete --');
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#memoryBtn'); await page.waitForTimeout(150);
  await page.fill('#newMemoryInput', 'regression test memory fact');
  await page.click('#addMemoryBtn'); await page.waitForTimeout(200);
  const memCountAfterAdd = await page.evaluate(() => document.querySelectorAll('#memoryList .pc').length);
  assert(memCountAfterAdd === 1, `memory count is 1 after add (got ${memCountAfterAdd})`);
  await page.click('#memoryList .cdb'); await page.waitForTimeout(200);
  const memCountAfterDelete = await page.evaluate(() => document.querySelectorAll('#memoryList .pc').length);
  assert(memCountAfterDelete === 0, `memory count is 0 after delete (got ${memCountAfterDelete})`);
  await page.click('#closeMemoryModal'); await page.waitForTimeout(150);

  console.log('\n-- tabs: create, isolate, switch back --');
  await page.click('#newTabBtn'); await page.waitForTimeout(400);
  const tabCount = await page.evaluate(() => document.querySelectorAll('#tabBar .tabpill').length);
  assert(tabCount === 2, `tab count is 2 after creating a new tab (got ${tabCount})`);
  const tabBEmpty = await page.evaluate(() => document.getElementById('chat').textContent.indexOf('quick test') < 0);
  assert(tabBEmpty, 'new tab starts empty, does not inherit prior tab content');
  await sendMsg('write a short poem');
  const pills = await page.$$('#tabBar .tabpill');
  await pills[0].click(); await page.waitForTimeout(600);
  const backOnTabA = await page.evaluate(() => document.getElementById('chat').textContent.indexOf('quick test') >= 0);
  assert(backOnTabA, 'switching back to tab A shows its original content');

  console.log('\n-- profile: create, isolate --');
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#profileBtn'); await page.waitForTimeout(150);
  await page.fill('#newProfileInput', 'RegressionTest');
  await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => {}), page.click('#addProfileBtn')]);
  await page.waitForTimeout(1200);
  const newProfileIsolated = await page.evaluate(() => document.getElementById('chat').textContent.indexOf('quick test') < 0);
  assert(newProfileIsolated, 'new profile does not see the default profile\'s chat data');
  const profileLabel = await page.textContent('#activeProfileLabel');
  assert(profileLabel.toLowerCase().indexOf('regressiontest') >= 0, `active profile label reflects the new profile (got "${profileLabel}")`);

  console.log(`\n-- page errors: ${realErrors().length} real (excluding expected sandbox network noise) --`);
  if (realErrors().length) console.log(realErrors());
  failures += realErrors().length;

  await browser.close();

  console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s) ===`);
  process.exit(failures === 0 ? 0 : 1);
})();
