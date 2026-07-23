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
   - merge_branch tool requires its own dedicated approval dialog before
     anything happens, and the approved branch/op reach the GitHub ops
     worker correctly
   - the final streaming call forces tool_choice:"none" so a model that
     wants to call another tool after a successful tool round doesn't
     silently render as "(empty response)"
   - the tool round loop actually advances multiple rounds within one
     message (not capped at one), and is bounded at MAX_TOOL_ROUNDS so a
     model that keeps wanting to call tools can't loop indefinitely
   - list_files no longer requires a path - its schema allows omitting it
     to mean the repo root
   - the auto-router actually prefers a tool-capable (DeepInfra) model for
     a repo-flavored message instead of silently landing on Claude/
     OpenRouter and losing all tool access
   - Manual import's "Fetch from Drive" guards against an unconnected/
     expired Drive session instead of silently failing
   - "Open" deep-links straight to the Drive folder by id, falling back to
     a name search only when no id is known yet
   - App-control tools (create_project/remember/switch_model) execute
     immediately on a model tool_call, with real observable side effects
   - Hardcoded app-structure knowledge only appears when GitHub is
     connected to this actual repo, not some other repo
   - the speak-replies-aloud toggle is off by default, actually calls
     speechSynthesis.speak once turned on, and stops again once turned off
   - voice-conversation mode: turning it on starts listening immediately,
     a finished utterance auto-sends with no Send tap, the reply is
     spoken even with the separate speak toggle off, and speaking's own
     end restarts listening for the next turn
   - picking a voice persists it and is actually set on the utterance
     when speaking; Overseer personality text persists and shows up in
     the system prompt sent to the model

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
  // Waits for the actual attach-list count to reach n instead of trusting a
  // fixed delay after setInputFiles - compressImg()'s async decode pipeline
  // competes with whatever else the page is doing (now more, per message,
  // since app-control tools add an extra request), so a flat timeout can
  // read attachedFiles as still-empty and send a message with no image at
  // all, which then falsely looks like the vision-switch itself failed.
  async function waitForAttachCount(n) {
    for (let i = 0; i < 20; i++) {
      const c = await page.evaluate(() => document.querySelectorAll('#attachItems .ai').length);
      if (c >= n) return;
      await page.waitForTimeout(150);
    }
  }

  // Headless Chromium exposes a real webkitSpeechRecognition constructor,
  // but calling .start() on it with no actual microphone/permission in
  // this sandbox can't be driven deterministically - it never fires
  // onresult with real transcript data. Replace it with a fully
  // controllable fake before the app's own init IIFE runs (it reads
  // window.SpeechRecognition once at load), so voice-conversation mode's
  // listen -> send -> speak -> listen loop can be exercised precisely.
  await page.addInitScript(() => {
    window.__recognitionStartCount = 0;
    function FakeSpeechRecognition() {
      this.onresult = null; this.onend = null; this.onerror = null;
      window.__fakeRecognition = this;
    }
    FakeSpeechRecognition.prototype.start = function () { window.__recognitionStartCount++; };
    FakeSpeechRecognition.prototype.stop = function () { if (this.onend) this.onend(); };
    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;
  });

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
  await waitForAttachCount(1);
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
  await waitForAttachCount(1);
  await page.fill('#prompt', '');
  await page.click('#sendBtn');
  await page.waitForTimeout(600);
  await dismissConfirmIfAny();
  await waitForSendDone();
  // Poll for the intercepted request body specifically, not just UI settle
  // time - unrouting before the request lands (a timing race, not an app
  // bug) reads lastRequestBody as null and misreports a failure. Same fix
  // already applied to the regen and repo-tools tests below.
  for (let i = 0; i < 60 && lastRequestBody === null; i++) await page.waitForTimeout(200);
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
  await waitForAttachCount(1);
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
  await waitForAttachCount(1);
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
  // App-control tools (create_project/switch_model/remember) are always
  // attached for a tool-capable model now, regardless of relevance - only
  // the repo tools (read_file/write_file/list_files) stay gated on
  // whether the message is actually code/github-relevant.
  const unrelatedToolNames = ((lastUnrelatedBody && lastUnrelatedBody.tools) || []).map((t) => t.function.name);
  assert(unrelatedToolNames.indexOf('read_file') < 0 && unrelatedToolNames.indexOf('write_file') < 0 && unrelatedToolNames.indexOf('list_files') < 0, `an unrelated (non-code/github) message gets no repo tools even with GitHub connected (got tools: ${JSON.stringify(unrelatedToolNames)})`);

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
  // The final streaming call still lists tools (so the model knows what it
  // already did/could have done) but must force tool_choice:"none" - that
  // call's reader only handles delta.content, so a real tool_choice:"auto"
  // here lets the model try to call a tool again after a successful first
  // round, which silently renders as "(empty response)" since nothing
  // reads or executes tool_calls deltas in the streaming loop.
  assert(lastRelatedBody && lastRelatedBody.tool_choice === 'none', `the final streaming call forces tool_choice:"none" so a tool-hungry model can't silently produce an empty response (got "${lastRelatedBody && lastRelatedBody.tool_choice}")`);
  // list_files used to require a path, so the model had no legitimate way
  // to ask for "the whole repo" - it had to guess a path or get an error
  // either way. Confirm the tool's own schema no longer forces one.
  const listFilesTool = (lastRelatedBody && lastRelatedBody.tools || []).find((t) => t.function.name === 'list_files');
  assert(listFilesTool && !(listFilesTool.function.parameters.required || []).includes('path'), 'list_files no longer requires a path - omitting it can mean "list the repo root"');

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

  console.log('\n-- Manual import: "Fetch from Drive" guards against an unconnected/expired session --');
  // Fetch from Drive pulls the file straight from the connected folder
  // instead of making the user copy its content out of the Drive app by
  // hand - but this sandbox has no real Google OAuth, so the only
  // reachable path here is the guard: with no Drive connection at all,
  // it must alert and leave the textarea untouched rather than silently
  // failing or hanging.
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#driveManualImportBtn'); await page.waitForTimeout(150);
  let fetchGuardDialogMessage = null;
  page.once('dialog', async (dialog) => { fetchGuardDialogMessage = dialog.message(); await dialog.accept(); });
  await page.click('#driveFetchFromDriveBtn');
  await page.waitForTimeout(300);
  assert(!!fetchGuardDialogMessage && fetchGuardDialogMessage.toLowerCase().indexOf('not connected') >= 0, `Fetch from Drive alerts when there's no Drive connection (got ${JSON.stringify(fetchGuardDialogMessage)})`);
  const importTextAfterFailedFetch = await page.inputValue('#driveImportText');
  assert(importTextAfterFailedFetch === '', 'the textarea stays empty when the fetch is blocked by the connection guard');
  await page.click('#closeDriveManualImportModal'); await page.waitForTimeout(150);

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

  console.log('\n-- "Open" jumps straight to the Drive folder instead of making you search for it --');
  // With a folder id already known (just locked in above), Open must deep-
  // link straight to that folder, not a name search - the whole point of
  // this button is skipping the "hunt through Drive for the right folder"
  // step entirely. This sandbox has no egress, so the popup's real
  // navigation to drive.google.com fails instantly and Chromium replaces
  // its url() with chrome-error://chromewebdata/ before we can read it -
  // fulfill the navigation at the context level (covers popups too, unlike
  // page-level routing) so it actually "loads" and keeps the real target URL.
  await page.context().route('https://drive.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>ok</body></html>' }));
  const [popupWithKnownId] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#driveFolderOpenBtn'),
  ]);
  await popupWithKnownId.waitForLoadState('domcontentloaded').catch(() => {});
  assert(popupWithKnownId.url().indexOf('regtestFolderId123') >= 0, `"Open" in Settings deep-links to the known folder id (got "${popupWithKnownId.url()}")`);
  await popupWithKnownId.close();
  await page.click('#driveManualImportBtn'); await page.waitForTimeout(150);
  const [popupFromImportModal] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#driveFolderOpenBtn2'),
  ]);
  await popupFromImportModal.waitForLoadState('domcontentloaded').catch(() => {});
  assert(popupFromImportModal.url().indexOf('regtestFolderId123') >= 0, `"Open the Drive folder itself" in Manual import deep-links to the same known folder id (got "${popupFromImportModal.url()}")`);
  await popupFromImportModal.close();
  await page.click('#closeDriveManualImportModal'); await page.waitForTimeout(150);
  // driveManualImportBtn hides Settings underneath before opening its own
  // modal (same pattern as githubConnectBtn), and closing it doesn't
  // reopen Settings - it has to be reopened explicitly to reach
  // driveFolderSetBtn next.
  await page.click('#settingsBtn'); await page.waitForTimeout(150);

  page.once('dialog', (dialog) => dialog.accept(''));
  await page.click('#driveFolderSetBtn');
  await page.waitForTimeout(200);
  const folderStatusAfterClear = await page.textContent('#driveFolderStatus');
  assert(folderStatusAfterClear.indexOf('Auto') >= 0, `clearing the input reverts to automatic folder detection (got "${folderStatusAfterClear}")`);

  const [popupWithNoId] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#driveFolderOpenBtn'),
  ]);
  await popupWithNoId.waitForLoadState('domcontentloaded').catch(() => {});
  assert(popupWithNoId.url().indexOf('ai-router-backups') >= 0, `with no folder id known, "Open" falls back to a name search instead of a dead link (got "${popupWithNoId.url()}")`);
  await popupWithNoId.close();
  await page.context().unroute('https://drive.google.com/**');

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
  let writeToolRoundCount = 0;
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
        writeToolRoundCount++;
        if (writeToolRoundCount === 1) {
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
        // The tool round loop keeps going until the model stops calling
        // tools - round 2 must say it's done, or it'd re-issue the same
        // write_file call and pop a second approval dialog nothing here
        // ever clicks through, hanging the send indefinitely.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'regtest done' } }] }),
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

  console.log('\n-- merge_branch tool requires its own approval dialog, and the approved branch/op reach the worker --');
  // merge_branch touches the repo's actual default branch - a materially
  // higher-stakes action than write_file - so it gets its own dedicated
  // confirm modal (githubMergeConfirmModal) instead of reusing
  // githubWriteConfirmModal. Verify the model-issued tool_call surfaces
  // that dialog, and that approving it sends the right op/branch to the
  // GitHub ops worker.
  await page.click('#modelBtn'); await page.waitForTimeout(150);
  await page.locator('.mc:has-text("Mistral Small")').first().click();
  await page.waitForTimeout(150);

  let capturedMergeBody = null;
  let mergeToolRoundCount = 0;
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.indexOf('github-ops-worker') >= 0 && req.method() === 'POST') {
      try { capturedMergeBody = JSON.parse(req.postData()); } catch (e) {}
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, prNumber: 42, prUrl: 'https://github.com/solmasta/openai-router/pull/42', merged: true, sha: 'regtestmergesha' }),
      });
      return;
    }
    if (req.method() === 'POST' && req.postData()) {
      let parsed = null;
      try { parsed = JSON.parse(req.postData()); } catch (e) {}
      if (parsed && parsed.stream === false) {
        mergeToolRoundCount++;
        if (mergeToolRoundCount === 1) {
          // The initial non-streaming tool-discovery call - fake a model
          // response that calls merge_branch for a fixed branch name.
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  tool_calls: [{
                    id: 'regtest_call_2',
                    type: 'function',
                    function: { name: 'merge_branch', arguments: JSON.stringify({ branch: 'ai-changes', title: 'regtest merge', message: 'regtest merge body' }) },
                  }],
                },
              }],
            }),
          });
          return;
        }
        // The tool round loop keeps going until the model stops calling
        // tools - round 2 must say it's done, or it'd re-issue the same
        // merge_branch call and pop a second approval dialog nothing here
        // ever clicks through, hanging the send indefinitely.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'regtest done' } }] }),
        });
        return;
      }
      if (parsed && parsed.stream === true) {
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
  await page.fill('#prompt', 'please merge the ai-changes branch into main now');
  await page.click('#sendBtn');
  let mergeConfirmShowed = false;
  for (let i = 0; i < 100; i++) {
    await dismissConfirmIfAny();
    mergeConfirmShowed = await page.evaluate(() => !document.getElementById('githubMergeConfirmModal').classList.contains('hidden'));
    if (mergeConfirmShowed) break;
    await page.waitForTimeout(200);
  }
  assert(mergeConfirmShowed, 'a model-issued merge_branch tool call surfaces its own dedicated approval dialog');
  const mergeBranchShown = await page.evaluate(() => document.getElementById('ghmBranch').textContent);
  assert(mergeBranchShown.indexOf('ai-changes') >= 0, `the confirm dialog shows the branch being merged (got "${mergeBranchShown}")`);
  await page.click('#ghmApproveBtn');
  await waitForSendDone();
  await page.unroute('**/*');
  assert(!!capturedMergeBody, 'approving the merge actually reaches the GitHub ops worker');
  assert(capturedMergeBody && capturedMergeBody.op === 'merge_branch', `the worker request is tagged with the merge_branch op (got "${capturedMergeBody && capturedMergeBody.op}")`);
  assert(capturedMergeBody && capturedMergeBody.branch === 'ai-changes', `the branch sent to the worker matches what was requested (got "${capturedMergeBody && capturedMergeBody.branch}")`);
  // waitForSendDone() above returns as soon as the Send button label flips
  // back, but autosave/tab-sync work triggered by the merge response can
  // still be settling - give it a beat before the next test starts
  // interacting, same as the settle wait already used after the Overseer
  // chat's failed (no-egress) request above.
  await page.waitForTimeout(500);

  console.log('\n-- tool round loop actually advances multiple rounds, not just one --');
  // Before this fix, a message got exactly ONE non-streaming round to call
  // a tool - a model that needed a second call (e.g. read_file right after
  // list_files) either had it silently vanish (old bug: streamed
  // "(empty response)") or, once the final call was locked to
  // tool_choice:"none", dumped the attempted call as literal text instead
  // (e.g. Qwen3 Coder's own <tool_call><function=...> training format)
  // since the structured path was closed but it still wanted to act.
  // Mock 2 sequential tool_calls rounds then a stop, and check both tools
  // actually ran.
  await page.click('#modelBtn'); await page.waitForTimeout(150);
  await page.locator('.mc:has-text("Mistral Small")').first().click();
  await page.waitForTimeout(150);

  let toolRoundCount = 0;
  let sawListFilesCall = false;
  let sawReadFileCall = false;
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.indexOf('github-ops-worker') >= 0 && req.method() === 'POST') {
      let opBody = null;
      try { opBody = JSON.parse(req.postData()); } catch (e) {}
      if (opBody && opBody.op === 'list_files') sawListFilesCall = true;
      if (opBody && opBody.op === 'read_file') sawReadFileCall = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, files: [{ name: 'index.html', type: 'file', path: 'index.html' }], content: 'regtest file content' }),
      });
      return;
    }
    if (req.method() === 'POST' && req.postData()) {
      let parsed = null;
      try { parsed = JSON.parse(req.postData()); } catch (e) {}
      if (parsed && parsed.stream === false) {
        toolRoundCount++;
        if (toolRoundCount === 1) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'regtest_round1', type: 'function', function: { name: 'list_files', arguments: JSON.stringify({}) } }] } }] }),
          });
          return;
        }
        if (toolRoundCount === 2) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'regtest_round2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'index.html' }) } }] } }] }),
          });
          return;
        }
        // Round 3: the model is done calling tools.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'regtest done' } }] }),
        });
        return;
      }
      if (parsed && parsed.stream === true) {
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
  await sendMsg('please read the readme after listing the repo');
  await page.unroute('**/*');
  assert(sawListFilesCall, 'round 1 of the tool loop actually calls list_files');
  assert(sawReadFileCall, 'round 2 of the tool loop actually calls read_file - the loop did not stop after just one round');
  assert(toolRoundCount === 3, `the loop stopped as soon as the model returned finish_reason:"stop" instead of always burning through every round (got ${toolRoundCount} non-streaming rounds, expected exactly 3)`);

  console.log('\n-- tool round loop is bounded, does not call tools forever --');
  // A model that keeps wanting to call tools every round must not loop
  // indefinitely - MAX_TOOL_ROUNDS caps it, after which the final
  // tool_choice:"none" call is the actual safety net that forces a text
  // answer regardless of what the model still wants to do.
  await page.click('#modelBtn'); await page.waitForTimeout(150);
  await page.locator('.mc:has-text("Mistral Small")').first().click();
  await page.waitForTimeout(150);

  let unboundedRoundCount = 0;
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.indexOf('github-ops-worker') >= 0 && req.method() === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, files: [] }) });
      return;
    }
    if (req.method() === 'POST' && req.postData()) {
      let parsed = null;
      try { parsed = JSON.parse(req.postData()); } catch (e) {}
      if (parsed && parsed.stream === false) {
        unboundedRoundCount++;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'regtest_round_' + unboundedRoundCount, type: 'function', function: { name: 'list_files', arguments: JSON.stringify({}) } }] } }] }),
        });
        return;
      }
      if (parsed && parsed.stream === true) {
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
  await sendMsg('please explore the repo as much as needed');
  await page.unroute('**/*');
  assert(unboundedRoundCount === 4, `the tool loop stops after MAX_TOOL_ROUNDS (4) rounds even if the model keeps returning tool_calls every time (got ${unboundedRoundCount} rounds)`);
  await page.waitForTimeout(500);

  console.log('\n-- auto-router prefers a tool-capable model for a repo-flavored message --');
  // scoreModelForTask used to try to reward a DeepInfra model for a
  // github-flavored message by checking model.id/label/desc for the
  // literal string "deepinfra" - no model's id/label/desc actually
  // contains that word, so the boost silently never fired for anything.
  // That meant the auto-router could switch to a Claude/OpenRouter model
  // for a repo-flavored message and silently lose all tool access (only
  // DeepInfra models are in TOOL_MODELS). Start on Claude, send a message
  // that's unambiguously repo-flavored, and confirm the router actually
  // switches to a tool-capable (DeepInfra) model instead of staying put.
  await page.click('#modelBtn'); await page.waitForTimeout(150);
  await page.click('#claudeBtn'); await page.waitForTimeout(300);
  await page.click('#closeModelModal'); await page.waitForTimeout(150);
  const backendBeforeGithubMsg = await page.evaluate(() => document.getElementById('claudeBtn').classList.contains('act') ? 'claude' : 'other');
  assert(backendBeforeGithubMsg === 'claude', 'test setup: starts on the Claude backend');
  await sendMsg('please check the current branch and commit history in the repo');
  const backendAfterGithubMsg = await page.evaluate(() => document.getElementById('deepinfraBtn').classList.contains('act') ? 'deepinfra' : 'other');
  assert(backendAfterGithubMsg === 'deepinfra', `a repo-flavored message auto-switches away from a non-tool-capable model to a DeepInfra (tool-capable) one (backend after send: "${backendAfterGithubMsg}")`);

  console.log('\n-- App-control tools (create_project/remember/switch_model) actually execute, no confirm needed --');
  // These are the Overseer's new "full autonomy" tools - unlike write_file
  // they run immediately on a model-issued tool_call, no approval dialog.
  // Mock all three in one tool_calls response and verify each one's real,
  // observable side effect: a project actually saved and made active, a
  // memory actually stored, and the model actually switched.
  await page.click('#modelBtn'); await page.waitForTimeout(150);
  await page.locator('.mc:has-text("Mistral Small")').first().click();
  await page.waitForTimeout(150);
  let appControlRoundCount = 0;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      let parsed = null;
      try { parsed = JSON.parse(req.postData()); } catch (e) {}
      if (parsed && parsed.stream === false) {
        appControlRoundCount++;
        if (appControlRoundCount === 1) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  tool_calls: [
                    { id: 'regtest_call_a', type: 'function', function: { name: 'create_project', arguments: JSON.stringify({ name: 'Regtest Tool Project', instructions: 'Regtest project instructions' }) } },
                    { id: 'regtest_call_b', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ fact: 'Regtest remembered fact' }) } },
                    { id: 'regtest_call_c', type: 'function', function: { name: 'switch_model', arguments: JSON.stringify({ model_id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' }) } },
                  ],
                },
              }],
            }),
          });
          return;
        }
        // The tool round loop keeps going until the model stops calling
        // tools - round 2 must say it's done, or these three tools would
        // re-run every round up to MAX_TOOL_ROUNDS for no reason.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'regtest done' } }] }),
        });
        return;
      }
      if (parsed && parsed.stream === true) {
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
  await sendMsg('please make this a project, remember something, and switch models for me');
  await page.unroute('**/*');

  const projectCreated = await page.evaluate(() => {
    const raw = localStorage.getItem(Object.keys(localStorage).find((k) => k.indexOf('ai_workprojects') >= 0));
    const parsed = raw ? JSON.parse(raw) : [];
    return parsed.some((p) => p.title === 'Regtest Tool Project' && p.instructions === 'Regtest project instructions');
  });
  assert(projectCreated, 'create_project tool call actually saves a new Work Project');
  const projectBadge = await page.textContent('#activePromptName');
  assert(projectBadge.indexOf('Regtest Tool Project') >= 0, `create_project sets the new project active (got badge "${projectBadge}")`);

  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#memoryBtn'); await page.waitForTimeout(150);
  const memoryRemembered = await page.evaluate(() => document.getElementById('memoryList').textContent.indexOf('Regtest remembered fact') >= 0);
  assert(memoryRemembered, 'remember tool call actually saves a memory');
  await page.click('#closeMemoryModal'); await page.waitForTimeout(150);

  const modelLabelAfterToolSwitch = await page.textContent('#modelBtnLabel');
  assert(modelLabelAfterToolSwitch === 'Llama 3.3 70B Turbo', `switch_model tool call actually switches the active model (got "${modelLabelAfterToolSwitch}")`);

  console.log('\n-- hardcoded app-structure knowledge only appears when the connected repo actually IS this app --');
  // Without this, a model asked to do "a checkup" or "add a feature" on
  // the app has to guess its own architecture from scratch every time.
  // It must only apply to solmasta/openai-router specifically - injecting
  // it for some other repo the user points GitHub at would just be wrong.
  // The previous test's create_project call left a Work Project active -
  // getModelSystemPrompt takes a completely different branch whenever a
  // project is active (the project's own instructions take over), which
  // would skip this block entirely regardless of GitHub state. Clear does
  // this too, but also matches how a real user would move on for a new
  // topic in this app.
  await page.click('#clearBtn'); await page.waitForTimeout(200);
  await page.click('#modelBtn'); await page.waitForTimeout(150);
  await page.locator('.mc:has-text("Mistral Small")').first().click();
  await page.waitForTimeout(150);
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#githubConnectBtn'); await page.waitForTimeout(150);
  await page.fill('#ghOwnerInput', 'solmasta');
  await page.fill('#ghRepoInput', 'openai-router');
  await page.click('#githubSaveBtn'); await page.waitForTimeout(150);
  let lastCheckupBody = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      try {
        const parsed = JSON.parse(req.postData());
        if (parsed.messages) lastCheckupBody = parsed;
      } catch (e) {}
    }
    await route.continue();
  });
  await sendMsg('can you do a maintenance checkup on the app');
  for (let i = 0; i < 60 && lastCheckupBody === null; i++) await page.waitForTimeout(200);
  await page.unroute('**/*');
  const checkupSysContent = ((lastCheckupBody && lastCheckupBody.messages) || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert(checkupSysContent.indexOf("THIS REPO IS THE APP YOU'RE RUNNING IN") >= 0, 'a maintenance/checkup request on the connected openai-router repo gets the hardcoded app-structure knowledge');

  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#githubConnectBtn'); await page.waitForTimeout(150);
  await page.fill('#ghOwnerInput', 'someoneelse');
  await page.fill('#ghRepoInput', 'unrelated-project');
  await page.click('#githubSaveBtn'); await page.waitForTimeout(150);
  let lastOtherRepoBody = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      try {
        const parsed = JSON.parse(req.postData());
        if (parsed.messages) lastOtherRepoBody = parsed;
      } catch (e) {}
    }
    await route.continue();
  });
  await sendMsg('can you do a maintenance checkup on the app');
  for (let i = 0; i < 60 && lastOtherRepoBody === null; i++) await page.waitForTimeout(200);
  await page.unroute('**/*');
  const otherRepoSysContent = ((lastOtherRepoBody && lastOtherRepoBody.messages) || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert(otherRepoSysContent.indexOf("THIS REPO IS THE APP YOU'RE RUNNING IN") < 0, 'the same request against a different connected repo does NOT get openai-router-specific knowledge');

  // Leave GitHub pointed back at the real repo, matching actual usage.
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.click('#githubConnectBtn'); await page.waitForTimeout(150);
  await page.fill('#ghOwnerInput', 'solmasta');
  await page.fill('#ghRepoInput', 'openai-router');
  await page.click('#githubSaveBtn'); await page.waitForTimeout(150);

  console.log('\n-- speak-replies-aloud toggle actually speaks completed responses, off by default --');
  // Off by default (speakEnabled starts false) - a completed response must
  // not call speechSynthesis.speak until the user explicitly turns the
  // toggle on, and must stop calling it again once turned back off.
  await page.evaluate(() => {
    window.__speakCalls = [];
    window.__speakVoiceCalls = [];
    // Mimics real speechSynthesis by actually firing the utterance's own
    // onstart/onend - later code (voice-conversation mode's auto-relisten,
    // the speak button's "speaking" pulse) hangs off those callbacks, and
    // a spy that only records the call without firing them would silently
    // break that for every test running after this one.
    window.speechSynthesis.speak = (utter) => {
      window.__speakCalls.push(utter.text);
      window.__speakVoiceCalls.push(utter.voice && utter.voice.name);
      if (utter.onstart) utter.onstart();
      if (utter.onend) utter.onend();
    };
  });
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      let parsed = null;
      try { parsed = JSON.parse(req.postData()); } catch (e) {}
      if (parsed && parsed.stream === true) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: 'data: {"choices":[{"delta":{"content":"regtest spoken reply"}}]}\n\ndata: [DONE]\n\n',
        });
        return;
      }
    }
    await route.continue();
  });
  await sendMsg('regtest message before enabling speak');
  const speakCallsBeforeToggle = await page.evaluate(() => window.__speakCalls.length);
  assert(speakCallsBeforeToggle === 0, 'speak-aloud is off by default - a completed response does not call speechSynthesis.speak');

  const speakBtnOffState = await page.evaluate(() => document.getElementById('speakBtn').classList.contains('on'));
  assert(!speakBtnOffState, 'speak button does not show as "on" before being toggled');
  await page.click('#speakBtn');
  const speakBtnOnState = await page.evaluate(() => document.getElementById('speakBtn').classList.contains('on'));
  assert(speakBtnOnState, 'clicking the speak button turns it on');

  await sendMsg('regtest message after enabling speak');
  const spokenTexts = await page.evaluate(() => window.__speakCalls);
  assert(spokenTexts.indexOf('regtest spoken reply') >= 0, `once enabled, a completed response is actually spoken (got calls: ${JSON.stringify(spokenTexts)})`);

  await page.click('#speakBtn');
  const speakBtnOffAgain = await page.evaluate(() => document.getElementById('speakBtn').classList.contains('on'));
  assert(!speakBtnOffAgain, 'clicking the speak button again turns it back off');
  await sendMsg('regtest message after disabling speak');
  const spokenCountAfterDisable = await page.evaluate(() => window.__speakCalls.length);
  assert(spokenCountAfterDisable === spokenTexts.length, 'once disabled again, a completed response does not call speechSynthesis.speak');
  await page.unroute('**/*');

  console.log('\n-- voice-conversation mode: listens, auto-sends on silence, speaks the reply, then listens again --');
  // The whole point of this mode is not having to touch mic or Send for
  // every turn - toggling it on starts listening immediately, a finished
  // utterance (recognition.onend firing with real text) auto-sends,
  // completing the reply speaks it aloud, and the utterance's own onend
  // restarts listening for the next turn - a continuous loop instead of
  // tap mic, wait, tap Send, repeat.
  // Pin a known model first, same as every other send-driving test in this
  // file - without it, send()'s own switchToBestModel call inherits
  // whatever model/backend a prior test happened to leave active, and can
  // switch again mid-flow for a low-signal message, changing workerUrl out
  // from under this test's route mock and turning the real (blocked in
  // this sandbox) network fetch into an unhandled "Failed to fetch".
  await page.click('#modelBtn'); await page.waitForTimeout(150);
  await page.locator('.mc:has-text("Mistral Small")').first().click();
  await page.waitForTimeout(150);
  const startCountBeforeToggle = await page.evaluate(() => window.__recognitionStartCount || 0);
  await page.click('#voiceModeBtn'); await page.waitForTimeout(150);
  const voiceModeOnState = await page.evaluate(() => document.getElementById('voiceModeBtn').classList.contains('on'));
  assert(voiceModeOnState, 'toggling voice-conversation mode on shows it as active');
  const micOnAfterToggle = await page.evaluate(() => document.getElementById('micBtn').classList.contains('on'));
  assert(micOnAfterToggle, 'turning voice-conversation mode on immediately starts listening (mic shows on)');
  const startCountAfterToggle = await page.evaluate(() => window.__recognitionStartCount);
  assert(startCountAfterToggle === startCountBeforeToggle + 1, 'turning voice-conversation mode on actually calls recognition.start() once');

  // Playwright's page.route() reliably intercepts requests fired from a
  // real click in every other test in this file, but the fetch this test
  // triggers - several async hops downstream of a synthetic
  // recognition.onend() call rather than a DOM event - was consistently
  // rejecting with "Failed to fetch" before the route handler's very first
  // line ever ran, across many repeated runs. Patching window.fetch itself
  // sidesteps whatever CDP-level timing quirk that is: it's the app's own
  // JS calling this function directly, no network/route layer involved.
  await page.evaluate(() => {
    window.__origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.indexOf('/secret') >= 0) {
        return new Response(JSON.stringify({ secret: 'regtest-secret' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (opts && opts.method === 'POST' && opts.body) {
        let parsed = null;
        try { parsed = JSON.parse(opts.body); } catch (e) {}
        if (parsed && parsed.stream === false) {
          // Whatever model/GitHub state carried over from earlier tests,
          // this test only cares about the voice loop, not tool behavior -
          // tell it there's nothing to call so it falls straight through
          // to the final streaming reply below.
          return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'regtest done' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (parsed && parsed.stream === true) {
          return new Response('data: {"choices":[{"delta":{"content":"regtest voice reply"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
      }
      return window.__origFetch(url, opts);
    };
  });
  // Simulate the browser reporting a finished, transcribed utterance -
  // shaped exactly like the real SpeechRecognition onresult event the
  // app's own handler expects (resultIndex + results[i][0].transcript +
  // results[i].isFinal).
  await page.evaluate(() => {
    window.__fakeRecognition.onresult({
      resultIndex: 0,
      results: { length: 1, 0: { length: 1, isFinal: true, 0: { transcript: 'regtest voice message' } } },
    });
  });
  const promptAfterResult = await page.inputValue('#prompt');
  assert(promptAfterResult === 'regtest voice message', `a transcribed result fills the compose box (got "${promptAfterResult}")`);

  // The real API fires onend on its own as soon as it detects the user
  // stopped talking - simulate that natural pause here.
  await page.evaluate(() => { window.__fakeRecognition.onend(); });
  await waitForSendDone();
  await page.evaluate(() => { window.fetch = window.__origFetch; delete window.__origFetch; });

  const promptClearedAfterAutoSend = await page.inputValue('#prompt');
  assert(promptClearedAfterAutoSend === '', 'the finished utterance auto-sent on its own - no Send tap required (compose box cleared)');
  // waitForSendDone() only guarantees the sendBtn label flipped back - poll
  // briefly for the actual speak/relisten side effects too, same reasoning
  // as the "poll for the intercepted body" fix used elsewhere in this file
  // for requests that can land a beat after the button state settles.
  let spokenAfterVoiceReply = null;
  for (let i = 0; i < 20; i++) {
    spokenAfterVoiceReply = await page.evaluate(() => window.__speakCalls[window.__speakCalls.length - 1]);
    if (spokenAfterVoiceReply === 'regtest voice reply') break;
    await page.waitForTimeout(200);
  }
  assert(spokenAfterVoiceReply === 'regtest voice reply', `the reply is spoken aloud even though the separate speak toggle is off (got "${spokenAfterVoiceReply}")`);
  let startCountAfterReply = null;
  for (let i = 0; i < 20; i++) {
    startCountAfterReply = await page.evaluate(() => window.__recognitionStartCount);
    if (startCountAfterReply === startCountAfterToggle + 1) break;
    await page.waitForTimeout(200);
  }
  assert(startCountAfterReply === startCountAfterToggle + 1, `once the reply finishes speaking, listening restarts on its own for the next turn (got start count ${startCountAfterReply}, expected ${startCountAfterToggle + 1})`);

  await page.click('#voiceModeBtn'); await page.waitForTimeout(150);
  const voiceModeOffState = await page.evaluate(() => document.getElementById('voiceModeBtn').classList.contains('on'));
  assert(!voiceModeOffState, 'toggling voice-conversation mode off turns it back off');
  const micOffAfterDisable = await page.evaluate(() => document.getElementById('micBtn').classList.contains('on'));
  assert(!micOffAfterDisable, 'turning voice-conversation mode off stops listening (mic shows off)');

  console.log('\n-- picking a voice persists it and actually gets used when speaking --');
  // getVoices() returns nothing in this headless sandbox (no system TTS
  // voices installed), and SpeechSynthesisVoice has no public constructor,
  // so there's no way to hand the native utterance.voice setter something
  // it will actually accept - it silently no-ops for a plain object.
  // Replace that property with a permissive one so what the app *tries*
  // to assign is actually observable, independent of what a real browser
  // would ultimately accept.
  await page.evaluate(() => {
    Object.defineProperty(SpeechSynthesisUtterance.prototype, 'voice', {
      configurable: true,
      get() { return this.__testVoice; },
      set(v) { this.__testVoice = v; },
    });
    window.speechSynthesis.getVoices = () => [{ name: 'regtest-voice', lang: 'en-US' }];
    const sel = document.getElementById('voiceSelect');
    const opt = document.createElement('option');
    opt.value = 'regtest-voice'; opt.textContent = 'regtest-voice (en-US)';
    sel.appendChild(opt);
    sel.value = 'regtest-voice';
    sel.dispatchEvent(new Event('change'));
  });
  const persistedVoiceName = await page.evaluate(() => localStorage.getItem('ai_voice_name'));
  assert(persistedVoiceName === 'regtest-voice', `picking a voice persists its name (got "${persistedVoiceName}")`);

  await page.click('#speakBtn'); await page.waitForTimeout(150);
  const speakBtnOnForVoiceTest = await page.evaluate(() => document.getElementById('speakBtn').classList.contains('on'));
  assert(speakBtnOnForVoiceTest, 'test setup: speak-aloud is on for this check');
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      let parsed = null;
      try { parsed = JSON.parse(req.postData()); } catch (e) {}
      if (parsed && parsed.stream === true) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: 'data: {"choices":[{"delta":{"content":"regtest voice-picker reply"}}]}\n\ndata: [DONE]\n\n',
        });
        return;
      }
    }
    await route.continue();
  });
  await sendMsg('regtest message to check the picked voice is used');
  await page.unroute('**/*');
  const usedVoiceName = await page.evaluate(() => window.__speakVoiceCalls[window.__speakVoiceCalls.length - 1]);
  assert(usedVoiceName === 'regtest-voice', `the picked voice is actually set on the utterance (got "${usedVoiceName}")`);
  await page.click('#speakBtn'); await page.waitForTimeout(150);

  console.log('\n-- Overseer personality is persisted and shapes the system prompt --');
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.fill('#personalityInput', 'regtest warm and playful');
  await page.evaluate(() => document.getElementById('personalityInput').dispatchEvent(new Event('input')));
  const persistedPersonality = await page.evaluate(() => localStorage.getItem('ai_overseer_personality'));
  assert(persistedPersonality === 'regtest warm and playful', `personality text persists (got "${persistedPersonality}")`);
  await page.click('#closeSettingsModal'); await page.waitForTimeout(150);

  let lastPersonalityBody = null;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.postData()) {
      try {
        const parsed = JSON.parse(req.postData());
        if (parsed.messages) lastPersonalityBody = parsed;
      } catch (e) {}
    }
    await route.continue();
  });
  await sendMsg('regtest message to check personality shows up in the system prompt');
  for (let i = 0; i < 60 && lastPersonalityBody === null; i++) await page.waitForTimeout(200);
  await page.unroute('**/*');
  const personalitySysContent = ((lastPersonalityBody && lastPersonalityBody.messages) || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert(personalitySysContent.indexOf('regtest warm and playful') >= 0, 'the persisted personality text is included in the system prompt sent to the model');
  // Clear it so it doesn't leak into other tests' system-prompt assertions.
  await page.click('#settingsBtn'); await page.waitForTimeout(150);
  await page.fill('#personalityInput', '');
  await page.evaluate(() => document.getElementById('personalityInput').dispatchEvent(new Event('input')));
  await page.click('#closeSettingsModal'); await page.waitForTimeout(150);

  console.log(`\n-- page errors: ${realErrors().length} real (excluding expected sandbox network noise) --`);
  if (realErrors().length) console.log(realErrors());
  failures += realErrors().length;

  await browser.close();

  console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s) ===`);
  process.exit(failures === 0 ? 0 : 1);
})();
