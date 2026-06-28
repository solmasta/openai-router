let workerUrl = "";

async function loadConfig() {
  try {
    const res = await fetch("config.json");
    const config = await res.json();

    workerUrl = config.worker_url;

    const select = document.getElementById("modelSelect");
    select.innerHTML = "";

    for (const model of config.models) {
      const opt = document.createElement("option");
      opt.value = model.id;
      opt.textContent = model.label;
      if (model.id === config.default_model) opt.selected = true;
      select.appendChild(opt);
    }

    select.disabled = false;
  } catch (err) {
    console.error("Config load failed:", err);
    document.getElementById("modelSelect").textContent = "Config error";
  }
}

document.getElementById("sendBtn").onclick = async () => {
  const prompt = document.getElementById("prompt").value.trim();
  if (!prompt) return;

  const model   = document.getElementById("modelSelect").value;
  const out     = document.getElementById("response");
  const btn     = document.getElementById("sendBtn");

  btn.disabled     = true;
  btn.textContent  = "Sending…";
  out.className    = "response loading";
  out.textContent  = "▋";

  try {
    const res = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error?.message || `HTTP ${res.status}`);
    }

    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new Error("Empty response from model.");

    out.className   = "response";
    out.textContent = reply;

  } catch (err) {
    out.className   = "response error";
    out.textContent = "Error: " + err.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = "Send";
  }
};

loadConfig();
