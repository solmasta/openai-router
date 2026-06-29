"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
let workerUrl    = "";
let allModels    = [];
let currentModel = { id: "", label: "" };
let history      = [];
let sending      = false;
let attachedFile = null;   // { type:"image"|"text", dataUrl?, content?, name }

// ── Config / Model Picker ─────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const res    = await fetch("config.json");
    const config = await res.json();
    workerUrl    = config.worker_url;
    allModels    = config.models;

    const def = allModels.find(m => m.id === config.default_model) || allModels[0];
    setModel(def);
    renderModelList();
    document.getElementById("modelBtn").disabled = false;
  } catch (err) {
    console.error("Config load failed:", err);
    document.getElementById("modelBtnLabel").textContent = "Error";
  }
}

function setModel(m) {
  currentModel = m;
  document.getElementById("modelBtnLabel").textContent = m.label;
}

function renderModelList() {
  const list = document.getElementById("modelList");
  list.innerHTML = "";

  const categories = [...new Set(allModels.map(m => m.category))];
  for (const cat of categories) {
    const header = document.createElement("div");
    header.className   = "model-cat-header";
    header.textContent = cat;
    list.appendChild(header);

    for (const m of allModels.filter(x => x.category === cat)) {
      const card = document.createElement("div");
      card.className = `model-card ${m.id === currentModel.id ? "active" : ""}`;
      card.innerHTML = `
        <div class="model-card-top">
          <span class="model-card-label">${esc(m.label)}</span>
          <span class="model-badge cat-${cat.toLowerCase()}">${cat}</span>
        </div>
        <div class="model-card-desc">${esc(m.description)}</div>`;
      card.addEventListener("click", () => {
        setModel(m);
        closeModal("modelModal");
        renderModelList();
      });
      list.appendChild(card);
    }
  }
}

// ── File Attachment ───────────────────────────────────────────────────────────

async function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX  = 1024;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const ratio = Math.min(MAX / width, MAX / height);
          width  = Math.round(width  * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function readTextFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsText(file);
  });
}

document.getElementById("attachBtn").addEventListener("click", () => {
  document.getElementById("fileInput").click();
});

document.getElementById("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";

  const preview = document.getElementById("attachPreview");

  if (file.type.startsWith("image/")) {
    const dataUrl = await compressImage(file);
    attachedFile  = { type: "image", dataUrl, name: file.name };
    preview.innerHTML = `
      <div class="attach-item">
        <img class="attach-thumb" src="${dataUrl}" alt="${esc(file.name)}">
        <span class="attach-name">${esc(file.name)}</span>
        <button class="attach-clear" id="clearAttach">✕</button>
      </div>`;
  } else {
    const content = await readTextFile(file);
    attachedFile  = { type: "text", content, name: file.name };
    preview.innerHTML = `
      <div class="attach-item">
        <span class="attach-icon-file">📄</span>
        <span class="attach-name">${esc(file.name)}</span>
        <button class="attach-clear" id="clearAttach">✕</button>
      </div>`;
  }

  preview.classList.remove("hidden");
  document.getElementById("clearAttach").addEventListener("click", clearAttachment);
});

function clearAttachment() {
  attachedFile = null;
  const preview = document.getElementById("attachPreview");
  preview.innerHTML = "";
  preview.classList.add("hidden");
}

// ── System Prompt Manager ─────────────────────────────────────────────────────

const PROMPTS_KEY = "ai_router_prompts";
let prompts   = [];
let activeId  = null;
let editingId = null;

function loadPrompts() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROMPTS_KEY) || "{}");
    prompts  = saved.prompts  || [];
    activeId = saved.activeId || null;
  } catch { prompts = []; activeId = null; }
  refreshActiveLabel();
}

function persistPrompts() {
  localStorage.setItem(PROMPTS_KEY, JSON.stringify({ prompts, activeId }));
}

function getActivePrompt() { return prompts.find(p => p.id === activeId) || null; }

function refreshActiveLabel() {
  const active = getActivePrompt();
  document.getElementById("activePromptName").textContent = active ? active.name : "System prompt";
  document.getElementById("systemDot").classList.toggle("dot-on", !!active);
}

function renderPromptList() {
  const list = document.getElementById("promptList");
  list.innerHTML = "";

  if (prompts.length === 0) {
    list.innerHTML = '<p class="empty-list">No prompts yet.<br>Tap <strong>+ New prompt</strong> to create one.</p>';
  } else {
    const noneCard = document.createElement("div");
    noneCard.className = `prompt-card ${!activeId ? "active" : ""}`;
    noneCard.innerHTML = `<div class="card-top"><span class="card-name muted">None</span></div><div class="card-sub">No system prompt active</div>`;
    noneCard.addEventListener("click", () => { activeId = null; persistPrompts(); refreshActiveLabel(); renderPromptList(); });
    list.appendChild(noneCard);

    for (const p of prompts) {
      const card = document.createElement("div");
      card.className = `prompt-card ${p.id === activeId ? "active" : ""}`;
      card.innerHTML = `
        <div class="card-top">
          <span class="card-name">${esc(p.name)}</span>
          <button class="card-edit-btn" data-id="${p.id}">Edit</button>
        </div>
        <div class="card-sub">${esc(p.content.slice(0, 110))}${p.content.length > 110 ? "…" : ""}</div>`;
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("card-edit-btn")) return;
        activeId = p.id; persistPrompts(); refreshActiveLabel(); renderPromptList();
      });
      card.querySelector(".card-edit-btn").addEventListener("click", (e) => {
        e.stopPropagation(); openPromptEditor(p.id);
      });
      list.appendChild(card);
    }
  }
}

function openPromptEditor(id = null) {
  editingId = id;
  const p   = id ? prompts.find(x => x.id === id) : null;
  document.getElementById("editorTitle").textContent       = id ? "Edit prompt" : "New prompt";
  document.getElementById("promptNameInput").value         = p ? p.name    : "";
  document.getElementById("promptContentInput").value      = p ? p.content : "";
  document.getElementById("deletePromptBtn").style.display = id ? "block"   : "none";
  openModal("promptEditor");
  setTimeout(() => document.getElementById("promptNameInput").focus(), 80);
}

function savePrompt() {
  const name    = document.getElementById("promptNameInput").value.trim();
  const content = document.getElementById("promptContentInput").value.trim();
  if (!name || !content) return;
  if (editingId) {
    const idx = prompts.findIndex(p => p.id === editingId);
    if (idx !== -1) prompts[idx] = { ...prompts[idx], name, content };
  } else {
    const id = Date.now().toString();
    prompts.push({ id, name, content });
    activeId = id;
  }
  persistPrompts(); refreshActiveLabel(); closeModal("promptEditor"); renderPromptList();
}

function deletePrompt() {
  if (!editingId) return;
  prompts  = prompts.filter(p => p.id !== editingId);
  if (activeId === editingId) activeId = null;
  persistPrompts(); refreshActiveLabel(); closeModal("promptEditor"); renderPromptList();
  editingId = null;
}

// ── Projects / Saved Chats ────────────────────────────────────────────────────

const PROJECTS_KEY  = "ai_router_projects";
let projects        = [];
let editingProjId   = null;
let viewingProjId   = null;

function loadProjects() {
  try { projects = JSON.parse(localStorage.getItem(PROJECTS_KEY) || "[]"); }
  catch { projects = []; }
}

function persistProjects() {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

function renderProjectList() {
  const list = document.getElementById("projectList");
  list.innerHTML = "";

  if (projects.length === 0) {
    list.innerHTML = '<p class="empty-list">No folders yet.<br>Create one to start saving chats.</p>';
    return;
  }

  for (const proj of projects) {
    const count = proj.conversations?.length || 0;
    const card  = document.createElement("div");
    card.className = "project-card";
    card.innerHTML = `
      <div class="card-top">
        <span class="card-name">📁 ${esc(proj.name)}</span>
        <div class="card-actions">
          <span class="card-count">${count} chat${count !== 1 ? "s" : ""}</span>
          <button class="card-edit-btn" data-id="${proj.id}">Edit</button>
        </div>
      </div>`;
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("card-edit-btn")) return;
      openConvsModal(proj.id);
    });
    card.querySelector(".card-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation(); openProjEditor(proj.id);
    });
    list.appendChild(card);
  }
}

function openConvsModal(projId) {
  viewingProjId = projId;
  const proj = projects.find(p => p.id === projId);
  document.getElementById("convsProjectName").textContent = proj.name;
  renderConvsList(proj);
  closeModal("projectsModal");
  openModal("convsModal");
}

function renderConvsList(proj) {
  const list = document.getElementById("convsList");
  const convs = proj.conversations || [];
  list.innerHTML = "";

  if (convs.length === 0) {
    list.innerHTML = '<p class="empty-list">No saved chats in this folder yet.</p>';
    return;
  }

  for (const conv of [...convs].reverse()) {
    const card = document.createElement("div");
    card.className = "conv-card";
    const date = new Date(conv.savedAt).toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" });
    card.innerHTML = `
      <div class="card-top">
        <span class="card-name">${esc(conv.title)}</span>
        <button class="card-del-btn" data-id="${conv.id}">✕</button>
      </div>
      <div class="card-sub">${esc(conv.modelLabel)} · ${date} · ${conv.messages.length} messages</div>`;
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("card-del-btn")) return;
      loadConversation(conv);
    });
    card.querySelector(".card-del-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      proj.conversations = proj.conversations.filter(c => c.id !== conv.id);
      persistProjects();
      renderConvsList(proj);
    });
    list.appendChild(card);
  }
}

function saveCurrentChat(projId) {
  if (history.length === 0) { alert("No conversation to save yet."); return; }
  const proj  = projects.find(p => p.id === projId);
  const first = history.find(m => m.role === "user");
  const raw   = typeof first?.content === "string" ? first.content : (first?.content?.find(c => c.type === "text")?.text || "Chat");
  const title = raw.slice(0, 50) + (raw.length > 50 ? "…" : "");
  proj.conversations = proj.conversations || [];
  proj.conversations.push({
    id:         Date.now().toString(),
    title,
    savedAt:    Date.now(),
    modelId:    currentModel.id,
    modelLabel: currentModel.label,
    messages:   history.map(m => ({
      role:    m.role,
      content: typeof m.content === "string"
        ? m.content
        : (m.content.find(c => c.type === "text")?.text || "") + (m.content.some(c => c.type === "image_url") ? " [image attached]" : "")
    }))
  });
  persistProjects();
  closeModal("projectsModal");
}

function loadConversation(conv) {
  if (history.length > 0 && !confirm("Load this conversation? Current chat will be cleared.")) return;
  history = conv.messages.map(m => ({ role: m.role, content: m.content }));
  const chat = document.getElementById("chat");
  chat.innerHTML = "";
  const def = allModels.find(m => m.id === conv.modelId);
  if (def) setModel(def);
  for (const m of history) appendMessage(m.role, m.content);
  closeModal("convsModal");
}

function openProjEditor(id = null) {
  editingProjId = id;
  const proj    = id ? projects.find(p => p.id === id) : null;
  document.getElementById("projEditorTitle").textContent  = id ? "Edit folder" : "New folder";
  document.getElementById("projNameInput").value          = proj ? proj.name : "";
  const delBtn = document.getElementById("deleteProjBtn");
  delBtn.classList.toggle("hidden", !id);
  openModal("projectEditor");
  setTimeout(() => document.getElementById("projNameInput").focus(), 80);
}

function saveProject() {
  const name = document.getElementById("projNameInput").value.trim();
  if (!name) return;
  if (editingProjId) {
    const proj = projects.find(p => p.id === editingProjId);
    if (proj) proj.name = name;
  } else {
    projects.push({ id: Date.now().toString(), name, conversations: [] });
  }
  persistProjects();
  closeModal("projectEditor");
  renderProjectList();
  editingProjId = null;
}

function deleteProject() {
  if (!editingProjId) return;
  projects = projects.filter(p => p.id !== editingProjId);
  persistProjects();
  closeModal("projectEditor");
  renderProjectList();
  editingProjId = null;
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function openModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

function bindModal(modalId, closeId) {
  document.getElementById(closeId).addEventListener("click", () => closeModal(modalId));
  document.getElementById(modalId).addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal(modalId);
  });
}

bindModal("modelModal",   "closeModelModal");
bindModal("promptModal",  "closePromptModal");
bindModal("promptEditor", "closeEditor");
bindModal("projectsModal","closeProjectsModal");
bindModal("convsModal",   "closeConvsModal");
bindModal("projectEditor","closeProjEditor");

document.getElementById("modelBtn").addEventListener("click",      () => openModal("modelModal"));
document.getElementById("systemToggle").addEventListener("click",  () => { renderPromptList(); openModal("promptModal"); });
document.getElementById("newPromptBtn").addEventListener("click",  () => { closeModal("promptModal"); openPromptEditor(null); });
document.getElementById("savePromptBtn").addEventListener("click", savePrompt);
document.getElementById("deletePromptBtn").addEventListener("click", deletePrompt);

document.getElementById("projectsBtn").addEventListener("click",   () => { renderProjectList(); openModal("projectsModal"); });
document.getElementById("newProjectBtn").addEventListener("click", () => { closeModal("projectsModal"); openProjEditor(null); });
document.getElementById("saveToProjectBtn").addEventListener("click", () => {
  // Show project list for pick-to-save
  const list = document.getElementById("projectList");
  // Add "save here" buttons to existing cards by re-rendering with save mode
  renderProjectListSaveMode();
});
document.getElementById("backToProjects").addEventListener("click", () => {
  closeModal("convsModal");
  renderProjectList();
  openModal("projectsModal");
});
document.getElementById("saveProjBtn").addEventListener("click",   saveProject);
document.getElementById("deleteProjBtn").addEventListener("click", deleteProject);

function renderProjectListSaveMode() {
  const list = document.getElementById("projectList");
  list.innerHTML = '<p class="empty-list" style="margin-bottom:8px;text-align:left;color:var(--text)">Save to which folder?</p>';

  if (projects.length === 0) {
    list.innerHTML += '<p class="empty-list">No folders yet. Create one first.</p>';
    return;
  }

  for (const proj of projects) {
    const btn = document.createElement("button");
    btn.className   = "full-w btn-primary";
    btn.style.marginBottom = "8px";
    btn.textContent = `📁 ${proj.name}`;
    btn.addEventListener("click", () => saveCurrentChat(proj.id));
    list.appendChild(btn);
  }
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function stripThink(t) {
  return t.replace(/<think>[\s\S]*?<\/think>\n?/g,"").replace(/<think>[\s\S]*$/,"").trim();
}

function renderText(t) {
  return esc(t).replace(/`([^`]+)`/g,'<code class="inline">$1</code>').replace(/\n/g,"<br>");
}

function renderContent(raw) {
  const text = typeof raw === "string" ? stripThink(raw) : raw;
  if (typeof text !== "string") return esc(JSON.stringify(text));
  let result = "", last = 0;
  const re   = /```(\w*)\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    result += renderText(text.slice(last, m.index));
    const lang = m[1].trim(), code = m[2].trim();
    let hl;
    try { hl = lang && hljs.getLanguage(lang) ? hljs.highlight(code,{language:lang}).value : hljs.highlightAuto(code).value; }
    catch { hl = esc(code); }
    result += `<div class="code-block"><div class="code-header"><span>${lang||"code"}</span><button class="copy-code" onclick="copyCode(this)">Copy</button></div><pre><code class="hljs">${hl}</code></pre></div>`;
    last = m.index + m[0].length;
  }
  return result + renderText(text.slice(last));
}

function copyCode(btn) {
  navigator.clipboard.writeText(btn.closest(".code-block").querySelector("code").textContent).then(() => {
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = "Copy"), 2000);
  });
}

// ── Chat ──────────────────────────────────────────────────────────────────────

function hideEmpty() { const el = document.getElementById("emptyState"); if (el) el.remove(); }

function scrollNear(el) {
  const chat = document.getElementById("chat");
  if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 150)
    el.scrollIntoView({ behavior:"smooth", block:"end" });
}

function appendMessage(role, content = "", streaming = false) {
  hideEmpty();
  const chat  = document.getElementById("chat");
  const wrap  = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  const label = document.createElement("div");
  label.className   = "msg-label";
  label.textContent = role === "user" ? "You" : currentModel.label;
  const body  = document.createElement("div");
  body.className = "msg-body";

  if (streaming) {
    body.innerHTML = '<span class="cursor">▋</span>';
    wrap.classList.add("streaming");
  } else if (Array.isArray(content)) {
    // Vision message — show text + image
    const txt = content.find(c => c.type === "text")?.text || "";
    const img = content.find(c => c.type === "image_url");
    body.innerHTML = (txt ? renderContent(txt) : "") +
      (img ? `<img class="msg-img" src="${img.image_url.url}" alt="attached">` : "");
  } else {
    body.innerHTML = renderContent(content);
  }

  wrap.appendChild(label);
  wrap.appendChild(body);

  if (role === "assistant") {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.className   = "btn-action";
    copyBtn.onclick     = () => {
      navigator.clipboard.writeText(body.innerText.replace(/\n\n/g,"\n")).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
      });
    };
    actions.appendChild(copyBtn);
    wrap.appendChild(actions);
  }

  chat.appendChild(wrap);
  wrap.scrollIntoView({ behavior:"smooth", block:"end" });
  return { wrap, body };
}

// ── Streaming ─────────────────────────────────────────────────────────────────

async function streamInto(res, wrap, body) {
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = "", full = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data: ")) continue;
        const d = t.slice(6);
        if (d === "[DONE]") { wrap.classList.remove("streaming"); body.innerHTML = renderContent(full); return full; }
        try {
          const chunk = JSON.parse(d).choices?.[0]?.delta?.content;
          if (chunk) { full += chunk; body.innerHTML = renderContent(full) + '<span class="cursor">▋</span>'; scrollNear(wrap); }
        } catch {}
      }
    }
  } finally { wrap.classList.remove("streaming"); body.innerHTML = renderContent(full); }
  return full;
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function send() {
  if (sending) return;
  const promptEl = document.getElementById("prompt");
  const text     = promptEl.value.trim();
  if (!text && !attachedFile) return;

  const activePrompt = getActivePrompt();
  const btn          = document.getElementById("sendBtn");

  sending = true; btn.disabled = true; btn.textContent = "Sending…";

  // Build message content
  let userContent;
  let historyContent;

  if (attachedFile?.type === "image") {
    userContent = [
      { type: "text",      text: text || "What do you see in this image?" },
      { type: "image_url", image_url: { url: attachedFile.dataUrl } }
    ];
    historyContent = userContent; // keep for display
  } else if (attachedFile?.type === "text") {
    const combined = `File: ${attachedFile.name}\n\`\`\`\n${attachedFile.content}\n\`\`\`\n\n${text}`.trim();
    userContent    = combined;
    historyContent = combined;
  } else {
    userContent    = text;
    historyContent = text;
  }

  history.push({ role: "user", content: historyContent });
  appendMessage("user", historyContent);
  promptEl.value = ""; promptEl.style.height = "";
  clearAttachment();

  const messages = [];
  if (activePrompt) messages.push({ role: "system", content: activePrompt.content });

  // For the API call, use userContent; for history after first message, keep historyContent
  const apiHistory = history.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
  messages.push(...apiHistory, { role: "user", content: userContent });

  const { wrap, body } = appendMessage("assistant", "", true);

  try {
    const res = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: currentModel.id, messages, temperature: 0.7, stream: true }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${res.status}`); }
    const reply = await streamInto(res, wrap, body);
    history.push({ role: "assistant", content: reply });
  } catch (err) {
    wrap.classList.remove("streaming");
    body.className = "msg-body error";
    body.innerHTML = "Error: " + esc(err.message);
    history.pop();
  } finally {
    sending = false; btn.disabled = false; btn.textContent = "Send";
  }
}

document.getElementById("sendBtn").addEventListener("click", send);
document.getElementById("prompt").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 180) + "px";
});
document.getElementById("clearBtn").addEventListener("click", () => {
  history = [];
  clearAttachment();
  document.getElementById("chat").innerHTML = '<div class="empty-state" id="emptyState">Select a model and start chatting.</div>';
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadConfig();
loadPrompts();
loadProjects();
