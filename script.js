"use strict";

let workerUrl  = "";
let history    = [];
let modelLabel = "";
let sending    = false;

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const res    = await fetch("config.json");
    const config = await res.json();
    workerUrl    = config.worker_url;

    const select = document.getElementById("modelSelect");
    select.innerHTML = "";
    for (const m of config.models) {
      const opt       = document.createElement("option");
      opt.value       = m.id;
      opt.textContent = m.label;
      if (m.id === config.default_model) opt.selected = true;
      select.appendChild(opt);
    }
    select.disabled = false;
    modelLabel      = select.options[select.selectedIndex].text;
    select.onchange = () => {
      modelLabel = select.options[select.selectedIndex].text;
    };
  } catch (err) {
    console.error("Config load failed:", err);
    document.getElementById("modelSelect").textContent = "Config error";
  }
}

// ── Prompt Manager ────────────────────────────────────────────────────────────

const STORE_KEY = "ai_router_prompts";
let prompts   = [];
let activeId  = null;
let editingId = null;

function loadPrompts() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    prompts  = saved.prompts  || [];
    activeId = saved.activeId || null;
  } catch {
    prompts = []; activeId = null;
  }
  refreshActiveLabel();
}

function persistPrompts() {
  localStorage.setItem(STORE_KEY, JSON.stringify({ prompts, activeId }));
}

function getActivePrompt() {
  return prompts.find(p => p.id === activeId) || null;
}

function refreshActiveLabel() {
  const active = getActivePrompt();
  document.getElementById("activePromptName").textContent = active ? active.name : "System prompt";
  document.getElementById("systemDot").classList.toggle("dot-on", !!active);
}

function openPromptModal() {
  renderPromptList();
  document.getElementById("promptModal").classList.remove("hidden");
}

function closePromptModal() {
  document.getElementById("promptModal").classList.add("hidden");
}

function renderPromptList() {
  const list = document.getElementById("promptList");
  list.innerHTML = "";

  if (prompts.length === 0) {
    list.innerHTML = '<p class="prompt-empty">No prompts yet.<br>Tap <strong>+ New prompt</strong> to create one.</p>';
  } else {
    const noneCard = document.createElement("div");
    noneCard.className = `prompt-card ${!activeId ? "active" : ""}`;
    noneCard.innerHTML = `
      <div class="prompt-card-top"><span class="prompt-name muted">None</span></div>
      <div class="prompt-preview">No system prompt active</div>`;
    noneCard.addEventListener("click", () => {
      activeId = null; persistPrompts(); refreshActiveLabel(); renderPromptList();
    });
    list.appendChild(noneCard);

    for (const p of prompts) {
      const card = document.createElement("div");
      card.className = `prompt-card ${p.id === activeId ? "active" : ""}`;
      card.innerHTML = `
        <div class="prompt-card-top">
          <span class="prompt-name">${esc(p.name)}</span>
          <button class="prompt-edit-btn" data-id="${p.id}">Edit</button>
        </div>
        <div class="prompt-preview">${esc(p.content.slice(0, 110))}${p.content.length > 110 ? "…" : ""}</div>`;
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("prompt-edit-btn")) return;
        activeId = p.id; persistPrompts(); refreshActiveLabel(); renderPromptList();
      });
      card.querySelector(".prompt-edit-btn").addEventListener("click", (e) => {
        e.stopPropagation(); openEditor(p.id);
      });
      list.appendChild(card);
    }
  }
}

function openEditor(id = null) {
  editingId = id;
  const p   = id ? prompts.find(x => x.id === id) : null;
  document.getElementById("editorTitle").textContent       = id ? "Edit prompt" : "New prompt";
  document.getElementById("promptNameInput").value         = p ? p.name    : "";
  document.getElementById("promptContentInput").value      = p ? p.content : "";
  document.getElementById("deletePromptBtn").style.display = id ? "block"  : "none";
  document.getElementById("promptEditor").classList.remove("hidden");
  setTimeout(() => document.getElementById("promptNameInput").focus(), 80);
}

function closeEditor() {
  document.getElementById("promptEditor").classList.add("hidden");
  editingId = null;
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
  persistPrompts(); refreshActiveLabel(); closeEditor(); renderPromptList();
}

function deleteActivePrompt() {
  if (!editingId) return;
  prompts  = prompts.filter(p => p.id !== editingId);
  if (activeId === editingId) activeId = null;
  persistPrompts(); refreshActiveLabel(); closeEditor(); renderPromptList();
}

// Modal events
document.getElementById("systemToggle").addEventListener("click", openPromptModal);
document.getElementById("closePromptModal").addEventListener("click", closePromptModal);
document.getElementById("promptModal").addEventListener("click", e => { if (e.target === e.currentTarget) closePromptModal(); });
document.getElementById("newPromptBtn").addEventListener("click", () => { closePromptModal(); openEditor(null); });
document.getElementById("closeEditor").addEventListener("click", closeEditor);
document.getElementById("promptEditor").addEventListener("click", e => { if (e.target === e.currentTarget) closeEditor(); });
document.getElementById("savePromptBtn").addEventListener("click", savePrompt);
document.getElementById("deletePromptBtn").addEventListener("click", deleteActivePrompt);

// ── Rendering ─────────────────────────────────────────────────────────────────

function esc(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>\n?/g,"").replace(/<think>[\s\S]*$/,"").trim();
}

function renderText(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
    .replace(/\n/g, "<br>");
}

function renderContent(raw) {
  const text = stripThink(raw);
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
  if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 150) el.scrollIntoView({behavior:"smooth",block:"end"});
}

function appendMessage(role, content = "", streaming = false) {
  hideEmpty();
  const chat = document.getElementById("chat");
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  const label = document.createElement("div");
  label.className   = "msg-label";
  label.textContent = role === "user" ? "You" : modelLabel;
  const body = document.createElement("div");
  body.className = "msg-body";
  if (streaming) { body.innerHTML = '<span class="cursor">▋</span>'; wrap.classList.add("streaming"); }
  else           { body.innerHTML = renderContent(content); }
  wrap.appendChild(label);
  wrap.appendChild(body);
  if (role === "assistant") {
    const actions   = document.createElement("div");
    actions.className = "msg-actions";
    const copyBtn   = document.createElement("button");
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
  wrap.scrollIntoView({behavior:"smooth",block:"end"});
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
      buffer += decoder.decode(value, {stream:true});
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
  if (!text) return;

  const activePrompt = getActivePrompt();
  const modelId      = document.getElementById("modelSelect").value;
  const btn          = document.getElementById("sendBtn");

  sending = true; btn.disabled = true; btn.textContent = "Sending…";

  history.push({ role: "user", content: text });
  appendMessage("user", text);
  promptEl.value = ""; promptEl.style.height = "";

  const messages = [];
  if (activePrompt) messages.push({ role: "system", content: activePrompt.content });
  messages.push(...history);

  const { wrap, body } = appendMessage("assistant", "", true);

  try {
    const res = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, messages, temperature: 0.7, stream: true }),
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
  document.getElementById("chat").innerHTML = '<div class="empty-state" id="emptyState">Select a model and start chatting.</div>';
});

loadConfig();
loadPrompts();
