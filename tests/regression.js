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
   - Overseer chat: long-press opens it, sends reach the model with the
     Overseer's own dedicated system prompt (not the main chat one)
   - write_file tool never defaults to main/master; the approved branch is
     what actually reaches the GitHub ops worker

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

  async function dismissConfirmIfAny() {
    const v = await page.evaluate(() => !document.getElementById('agentConfirmModal').classList.contains('hidden'));
    if (v) { await page.click('#agentConfirmSendCurrent'); await page.waitForTimeout(300); }
    return v;
  }
  async function waitForSendDone() {
    // Check for the model-switch confirm modal on every iteration, not just
    // once right after the click - switchToBestModel's scoring can finish
    // later than a single fixed check under slower conditions, and a missed
    // modal sits open blocking every later test in the file, not just this one.
    // 25 * 300ms (7.5s) assumed the sandbox's proxy rejects the (expected
    // to fail) worker requests almost instantly. That rejection latency
    // varies and was creeping past 7.5s, so this returned early with the
    // send still genuinely in flight - every assertion checking "did it
    // finish" then read stale mid-request state and failed for a reason
    // that had nothing to do with app correctness. A dismissed switch-
    // model confirm still has to wait out the same slow rejection
    // afterward, compounding the delay - 150 * 300ms = 45s gives real
    // slow-rejection cases room to actually finish either way.
    for (let i = 0; i < 150; i++) {
      await dismissConfirmIfAny();
      const t = await page.textContent('#sendBtn');
      if (t.indexOf('Send') >= 0) return;
      await page.waitForTimeout(300);
    }
  }
  async function sendMsg(text) {
    await page.fill('#prompt', text);
    await page.click('#sendBtn');
    await page.waitForTimeout(600);
    await dismissConfirmIfAny();
    await waitForSendDone();
  }

  // 'load' waits for every subresource to settle, including the external
  // Google/Workers scripts this sandbox's proxy is set up to reject - how
  // long that rejection takes varies, and it was creeping close enough to
  // the timeout to fail outright at random. domcontentloaded doesn't need
  // those external loads to resolve at all, and the app is interactive
  // well before they would anyway.
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
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

  console.log('\n-- project detail\'s Edit button closes the detail modal underneath it --');
  // wprojEditor is earlier in the DOM than wprojDetail, and both share the
  // same z-index, so if wprojDetail is left open when the editor opens on
  // top of it, wprojDetail (later in DOM) paints over the editor instead -
  // the editor is technically open but invisible, sitting behind the
  // project page the user was already on.
  await page.click('#wprojBtn'); await page.waitForTimeout(150);
  await page.click('#newWprojBtn'); await page.waitForTimeout(150);
  await page.fill('#wprojNameInput', 'Regtest Edit Project');
  await page.fill('#wprojInstrInput', 'regtest instructions');
  await page.click('#saveWprojBtn'); await page.waitForTimeout(150);
  await page.click('#wprojBtn'); await page.waitForTimeout(150);
  await page.click('.pjc'); await page.waitForTimeout(150);
  await page.click('#editWprojBtn'); await page.waitForTimeout(150);
  const detailHiddenAfterEdit = await page.evaluate(() => document.getElementById('wprojDetail').classList.contains('hidden'));
  const editorVisibleAfterEdit = await page.evaluate(() => !document.getElementById('wprojEditor').classList.contains('hidden'));
  assert(detailHiddenAfterEdit, 'project detail modal closes when Edit is tapped (does not stack over the editor)');
  assert(editorVisibleAfterEdit, 'project editor is actually visible after tapping Edit');
  await page.click('#closeWprojEditor'); await page.waitForTimeout(150);

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
  await page.waitForTimeout(800);
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
  await page.waitForTimeout(800);
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

  console.log('\n-- an undecodable "image" file surfaces an error instead of hanging forever --');
  // compressImg() had no error handling on the FileReader or Image objects -
  // a file the browser's <img> can't decode (some HEIC variants are
  // inconsistently supported despite iOS's own photo picker previewing them
  // fine) left the promise never settling, so the attach handler's `await`
  // hung forever: the photo just silently never appeared, with nothing to
  // recover from short of a reload.
  const corruptImgPath = path.join(os.tmpdir(), 'regression_corrupt.png');
  fs.writeFileSync(corruptImgPath, Buffer.from('this is not a real png file, just garbage bytes'));
  let dialogMessage = null;
  page.once('dialog', async (dialog) => { dialogMessage = dialog.message(); await dialog.accept(); });
  const fileInputBad = await page.$('#fileInput');
  await fileInputBad.setInputFiles({ name: 'corrupt.png', mimeType: 'image/png', buffer: fs.readFileSync(corruptImgPath) });
  await page.waitForTimeout(1500);
  assert(!!dialogMessage && dialogMessage.indexOf('corrupt.png') >= 0, `an undecodable image triggers a clear error naming the file (got dialog: ${JSON.stringify(dialogMessage)})`);
  const attachCountAfterBadFile = await page.evaluate(() => document.querySelectorAll('#attachItems .ai').length);
  assert(attachCountAfterBadFile === 0, 'the undecodable file itself is not added to the attachment list');
  // The app must still work normally afterward - one bad file shouldn't leave anything stuck.
  const fileInputRecover = await page.$('#fileInput');
  await fileInputRecover.setInputFiles(imgPath);
  await page.waitForTimeout(800);
  const attachCountAfterGoodFile = await page.evaluate(() => document.querySelectorAll('#attachItems .ai').length);
  assert(attachCountAfterGoodFile === 1, 'a valid image still attaches normally right after a failed one');
  await page.evaluate(() => { document.querySelectorAll('#attachItems .ac2').forEach(function(b){b.click();}); });
  await page.waitForTimeout(200);

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
  for (let i = 0; i < 60 && lastRegenBody === null; i++) await page.waitForTimeout(200);
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
  await page.waitForTimeout(800);
  await sendMsg('what is in this image');
  await page.unroute('**/*');
  assert(lastReqBodyWithTools && !lastReqBodyWithTools.tools, 'vision model image request has no tools field with GitHub connected');

  console.log('\n-- repo tools are only offered when the message is actually code/github-relevant --');
  // GitHub connected + a tool-capable model must not get REPO_TOOLS for a
  // message unrelated to code or the repo - tools used to be offered
  // unconditionally whenever GitHub was connected, so an unrelated
  // question (e.g. about crypto/markets) could make a small model
  // hallucinate a git clone and go hunting for nonexistent repo files
  // instead of just answering.
  let lastUnrelatedBody = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      try {
        const parsed = JSON.parse(req.postData());
        if (parsed.messages) lastUnrelatedBody = parsed;
      } catch (e) {}
    }
    await route.continue();
  });
  await sendMsg('what is dtcc and how does it relate to xrp');
  // Poll for the intercepted body specifically - unrouting before the
  // request lands (a timing race, not an app bug) reads it as null and
  // misreports a failure. Same fix already applied to the regen test.
  for (let i = 0; i < 60 && lastUnrelatedBody === null; i++) await page.waitForTimeout(200);
  await page.unroute('**/*');
  assert(lastUnrelatedBody && !lastUnrelatedBody.tools, 'an unrelated (non-code/github) message gets no tools field even with GitHub connected');

  let lastRelatedBody = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      try {
        const parsed = JSON.parse(req.postData());
        if (parsed.messages) lastRelatedBody = parsed;
      } catch (e) {}
    }
    await route.continue();
  });
  await sendMsg('please read the README file from the github repo');
  for (let i = 0; i < 60 && lastRelatedBody === null; i++) await page.waitForTimeout(200);
  await page.unroute('**/*');
  assert(lastRelatedBody && Array.isArray(lastRelatedBody.tools) && lastRelatedBody.tools.length > 0, 'a genuinely code/github-relevant message still gets the repo tools');

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
  // A locator auto-waits for the element to actually be there; page.$$()
  // takes an instant snapshot and can catch the tab bar mid-re-render,
  // returning zero elements and crashing on pills[0].click().
  await page.locator('#tabBar .tabpill').first().click();
  await page.waitForTimeout(600);
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

  console.log('\n-- manual Drive-file import writes straight to localStorage, no API calls --');
  // Recovery path for when Drive itself is rate-limited/disconnected -
  // paste a file's raw content and it's written directly, matching
  // exactly what driveApplyRestoredData would have written from a real
  // Drive download, but with zero network involved.
  const importedProjects = [{ id: 'regtestImported', title: 'Imported Project', instructions: 'regtest imported instructions', createdAt: Date.now(), conversations: [] }];
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#driveManualImportBtn'); await page.waitForTimeout(150);
  await page.selectOption('#driveImportType', 'workprojects');
  await page.fill('#driveImportText', JSON.stringify(importedProjects));
  page.once('dialog', (dialog) => dialog.accept());
  await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => {}), page.click('#driveManualImportApplyBtn')]);
  await page.waitForTimeout(1000);
  const importedRaw = await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.indexOf('ai_workprojects') >= 0)));
  const importedParsed = importedRaw ? JSON.parse(importedRaw) : null;
  assert(importedParsed && importedParsed.length === 1 && importedParsed[0].id === 'regtestImported', `manually imported workprojects data is written to localStorage (got ${importedRaw})`);

  console.log('\n-- Drive folder can be manually locked by ID, bypassing name-based search --');
  // Name-based folder search is what created a duplicate "ai-router-backups"
  // folder in the first place - pinning an exact folder ID sidesteps that
  // entirely for any device that sets it.
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  page.once('dialog', (dialog) => dialog.accept('https://drive.google.com/drive/folders/regtestFolderId123'));
  await page.click('#driveFolderSetBtn');
  await page.waitForTimeout(200);
  const folderStatusAfterSet = await page.textContent('#driveFolderStatus');
  assert(folderStatusAfterSet.indexOf('regtestFolderId123') >= 0, `folder status reflects the locked-in folder id (got "${folderStatusAfterSet}")`);
  const lockedFolderId = await page.evaluate(() => localStorage.getItem(Object.keys(localStorage).find((k) => k.indexOf('drive_folder_id') >= 0 && k.indexOf('locked') < 0)));
  assert(lockedFolderId === 'regtestFolderId123', `the extracted folder id (not the full URL) is what gets saved (got "${lockedFolderId}")`);
  page.once('dialog', (dialog) => dialog.accept(''));
  await page.click('#driveFolderSetBtn');
  await page.waitForTimeout(200);
  const folderStatusAfterClear = await page.textContent('#driveFolderStatus');
  assert(folderStatusAfterClear.indexOf('Auto') >= 0, `clearing the input reverts to automatic folder detection (got "${folderStatusAfterClear}")`);

  console.log('\n-- Overseer chat: long-press opens it, a sent message renders and reaches the model with a dedicated system prompt --');
  // Settings was left open by the previous test - it shares the same
  // z-index as the new chat modal and sits later in the DOM, so leaving it
  // open would silently intercept clicks meant for the chat modal
  // underneath (the same class of bug fixed earlier for wprojDetail).
  await page.click('#closeSettingsModal'); await page.waitForTimeout(150);
  // Long-press (500ms hold) on the Overseer button opens the strategy chat,
  // distinct from the quick-tap ON/OFF toggle - dispatch the same
  // mousedown/mouseup timing the real handler listens for.
  await page.dispatchEvent('#overseerBtn', 'mousedown');
  await page.waitForTimeout(700);
  await page.dispatchEvent('#overseerBtn', 'mouseup');
  await page.waitForTimeout(200);
  const overseerChatOpen = await page.evaluate(() => !document.getElementById('overseerChatModal').classList.contains('hidden'));
  assert(overseerChatOpen, 'long-pressing the Overseer button opens the strategy chat modal');

  let lastOverseerChatBody = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      try {
        const parsed = JSON.parse(req.postData());
        if (parsed.messages && parsed.messages.some((m) => typeof m.content === 'string' && m.content.indexOf('strategic advisor') >= 0)) {
          lastOverseerChatBody = parsed;
        }
      } catch (e) {}
    }
    await route.continue();
  });
  await page.fill('#overseerChatInput', 'regtest strategy question, what should I try next');
  await page.click('#overseerChatSendBtn');
  for (let i = 0; i < 60 && lastOverseerChatBody === null; i++) await page.waitForTimeout(200);
  await page.unroute('**/*');
  const overseerChatUserBubbleShown = await page.evaluate(() => document.getElementById('overseerChatLog').textContent.indexOf('regtest strategy question') >= 0);
  assert(overseerChatUserBubbleShown, 'sent strategy question renders in the Overseer chat log');
  assert(!!lastOverseerChatBody, 'the strategy question reaches the model tagged with the Overseer\'s own dedicated system prompt, not the main chat one');
  await page.waitForTimeout(1500); // let the failed (no-egress) request settle into its error state
  await page.click('#closeOverseerChatModal'); await page.waitForTimeout(150);
  const overseerChatClosed = await page.evaluate(() => document.getElementById('overseerChatModal').classList.contains('hidden'));
  assert(overseerChatClosed, 'Overseer chat modal closes via its close button');

  console.log('\n-- write_file tool never defaults to main/master, and the approved branch is what actually reaches the worker --');
  // write_file used to have no branch parameter at all - the ops worker
  // defaulted every write straight onto the repo's default branch, and
  // nothing in the approval dialog said so. This mocks a full model
  // tool_call for write_file with no branch specified and checks the whole
  // path: the approval dialog must default to a non-main working branch,
  // and that same branch (not "main") must be what's actually POSTed to
  // the GitHub ops worker once approved.
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#githubConnectBtn'); await page.waitForTimeout(150);
  await page.fill('#ghOwnerInput', 'solmasta');
  await page.fill('#ghRepoInput', 'openai-router');
  await page.click('#githubSaveBtn'); await page.waitForTimeout(150);
  // githubConnectBtn hides Settings underneath before opening its own
  // modal (see its click handler) and Save & Connect only closes that
  // sub-modal, so Settings is already out of the way here - nothing left
  // to close.
  // Force a known tool-capable model instead of trusting whatever
  // switchToBestModel might auto-pick for this message - only some
  // DeepInfra models are in TOOL_MODELS, and picking one outside that list
  // would skip the tool-call path entirely for reasons unrelated to this fix.
  await page.click('#modelBtn'); await page.waitForTimeout(150);
  await page.locator('.mc:has-text("Mistral Small")').first().click();
  await page.waitForTimeout(150);

  let capturedWriteBody = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.indexOf('github-ops-worker') >= 0 && req.method() === 'POST') {
      try { capturedWriteBody = JSON.parse(req.postData()); } catch (e) {}
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, commit: 'regtestcommitsha', branch: capturedWriteBody && capturedWriteBody.branch }),
      });
      return;
    }
    if (req.method() === 'POST' && req.postData()) {
      let parsed = null;
      try { parsed = JSON.parse(req.postData()); } catch (e) {}
      if (parsed && parsed.stream === false) {
        // The initial non-streaming tool-discovery call - fake a model
        // response that calls write_file with NO branch specified, the
        // exact case that used to silently land on the default branch.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'regtest_call_1',
                  type: 'function',
                  function: { name: 'write_file', arguments: JSON.stringify({ path: 'regtest.txt', content: 'hello world', message: 'regtest commit' }) },
                }],
              },
            }],
          }),
        });
        return;
      }
      if (parsed && parsed.stream === true) {
        // The final streaming call after tool results are folded in - a
        // minimal SSE body so the reader loop completes cleanly.
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: 'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
        });
        return;
      }
    }
    await route.continue();
  });
  await page.fill('#prompt', 'please create a new file in the github repo, hello world content');
  await page.click('#sendBtn');
  let confirmShowed = false;
  for (let i = 0; i < 100; i++) {
    await dismissConfirmIfAny();
    confirmShowed = await page.evaluate(() => !document.getElementById('githubWriteConfirmModal').classList.contains('hidden'));
    if (confirmShowed) break;
    await page.waitForTimeout(200);
  }
  assert(confirmShowed, 'a model-issued write_file tool call surfaces the approval dialog');
  const branchDefaultForNoBranch = await page.inputValue('#ghwBranch');
  assert(branchDefaultForNoBranch === 'ai-changes', `a write_file call with no branch specified defaults the approval dialog to a non-main working branch (got "${branchDefaultForNoBranch}")`);
  await page.click('#ghwApproveBtn');
  await waitForSendDone();
  await page.unroute('**/*');
  assert(!!capturedWriteBody, 'approving the write actually reaches the GitHub ops worker');
  assert(capturedWriteBody && capturedWriteBody.branch === 'ai-changes', `the approved branch (not "main") is what's actually sent to the worker (got "${capturedWriteBody && capturedWriteBody.branch}")`);

  console.log(`\n-- page errors: ${realErrors().length} real (excluding expected sandbox network noise) --`);
  if (realErrors().length) console.log(realErrors());
  failures += realErrors().length;

  await browser.close();

  console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s) ===`);
  process.exit(failures === 0 ? 0 : 1);
})();
