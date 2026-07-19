"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
let workerUrl    = "";
let driveWorkerUrl = "";
let allModels    = [];
let currentModel = { id: "", label: "" };
let history      = [];
let sending      = false;
let attachedFile = null;   // { type:"image"|"text", dataUrl?, content?, name }

// ── Drive Auth State ──────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = "899534056653-eb854ngfhontj1v370l0luj6fd1s6hcj.apps.googleusercontent.com";
const GOOGLE_REDIRECT_URI = "https://solmasta.github.io/callback";
const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.file";

let driveAuth = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
};

let autoBackupInterval = null;

// ── Config / Model Picker ─────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const res    = await fetch("config.json");
    const config = await res.json();
    workerUrl    = config.worker_url;
    driveWorkerUrl = config.drive_worker_url;
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

// ── Google Drive Integration ──────────────────────────────────────────────────

function loadDriveAuth() {
  try {
    const saved = JSON.parse(localStorage.getItem("drive_auth") || "{}");
    driveAuth = { ...driveAuth, ...saved };
  } catch { }
}

function saveDriveAuth() {
  localStorage.setItem("drive_auth", JSON.stringify(driveAuth));
}

function startGoogleOAuth() {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: DRIVE_SCOPES,
    access_type: "offline",
    prompt: "consent",
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function handleGoogleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");

  if (error) {
    console.error("OAuth error:", error);
    alert("Google authentication failed. Please try again.");
    window.history.replaceState({}, "", "/");
    return;
  }

  if (!code) return;

  try {
    const res = await fetch(`${driveWorkerUrl}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    const data = await res.json();

    if (data.error) throw new Error(data.error);

    driveAuth.accessToken = data.access_token;
    if (data.refresh_token) driveAuth.refreshToken = data.refresh_token;
    driveAuth.expiresAt = Date.now() + (data.expires_in * 1000);

    saveDriveAuth();
    updateDriveAuthUI();
    startAutoBackup();
    alert("Google Drive connected! Auto-backups enabled.");
    window.history.replaceState({}, "", "/");
  } catch (err) {
    console.error("Token exchange failed:", err);
    alert("Failed to connect to Google Drive.");
  }
}

async function refreshDriveToken() {
  if (!driveAuth.refreshToken) return false;

  try {
    const res = await fetch(`${driveWorkerUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: driveAuth.refreshToken }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    driveAuth.accessToken = data.access_token;
    driveAuth.expiresAt = Date.now() + (data.expires_in * 1000);
    saveDriveAuth();
    return true;
  } catch (err) {
    console.error("Token refresh failed:", err);
    driveAuth.accessToken = null;
    driveAuth.refreshToken = null;
    saveDriveAuth();
    return false;
  }
}

async function ensureValidToken() {
  if (!driveAuth.accessToken) return false;
  if (driveAuth.expiresAt && Date.now() >= driveAuth.expiresAt) {
    return await refreshDriveToken();
  }
  return true;
}

async function createDriveBackup() {
  if (!await ensureValidToken()) return false;

  const fileName = `ai-router-backup-${new Date().toISOString()}.json`;
  const content = JSON.stringify({
    version: 1,
    timestamp: Date.now(),
    model: currentModel,
    history,
    prompts,
    projects,
  }, null, 2);

  try {
    const res = await fetch(`${driveWorkerUrl}/drive/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName,
        content,
        accessToken: driveAuth.accessToken,
      }),
    });

    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    console.log("Backup uploaded to Drive");
    return true;
  } catch (err) {
    console.error("Backup failed:", err);
    return false;
  }
}

function updateDriveAuthUI() {
  const btn = document.getElementById("driveAuthBtn");
  if (!btn) return;

  if (driveAuth.accessToken) {
    btn.textContent = "✓ Drive Connected";
    btn.classList.add("connected");
    btn.disabled = true;
  } else {
    btn.textContent = "Connect Google Drive";
    btn.classList.remove("connected");
    btn.disabled = false;
  }
}

function disconnectDrive() {
  driveAuth = { accessToken: null, refreshToken: null, expiresAt: null };
  saveDriveAuth();
  stopAutoBackup();
  updateDriveAuthUI();
}

function startAutoBackup() {
  if (autoBackupInterval) return;
  autoBackupInterval = setInterval(async () => {
    if (driveAuth.accessToken) {
      await createDriveBackup();
    }
  }, 30000);
}

function stopAutoBackup() {
  if (autoBackupInterval) {
    clearInterval(autoBackupInterval);
    autoBackupInterval = null;
  }
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
document.ge
