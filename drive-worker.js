const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Google OAuth config
const CLIENT_ID = "899534056653-eb854ngfhontj1v370l0luj6fd1s6hcj.apps.googleusercontent.com";
const REDIRECT_URI = "https://solmasta.github.io/callback";
const BACKUP_FOLDER_ID = "13rTc6dbap5eMEKiodq0AYVkeHV-NUrg-";

// Exchange auth code for access token
async function exchangeCodeForToken(code, env) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  return res.json();
}

// Refresh access token using refresh token
async function refreshAccessToken(refreshToken, env) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json();
  return data;
}

// Upload snapshot file to Google Drive
async function uploadSnapshot(fileName, content, accessToken) {
  const metadata = {
    name: fileName,
    parents: [BACKUP_FOLDER_ID],
  };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", new Blob([content], { type: "application/json" }));

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    },
    body: form,
  });

  return res.json();
}

// List all backups in the backup folder
async function listBackups(accessToken) {
  const query = encodeURIComponent(`'${BACKUP_FOLDER_ID}' in parents and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name,createdTime,modifiedTime)&orderBy=createdTime%20desc`,
    {
      headers: { "Authorization": `Bearer ${accessToken}` },
    }
  );

  return res.json();
}

// Get file content from Drive
async function getFileContent(fileId, accessToken) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });

  return res.text();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405, headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    let body;
    try { body = await request.json(); }
    catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400, headers: { "Content-Type": "application/json", ...CORS }
      });
    }

    // POST /auth/exchange - exchange auth code for token
    if (url.pathname === "/auth/exchange") {
      const { code } = body;
      if (!code) {
        return new Response(JSON.stringify({ error: "Missing code" }), {
          status: 400, headers: { "Content-Type": "application/json", ...CORS }
        });
      }

      try {
        const tokenData = await exchangeCodeForToken(code, env);
        return new Response(JSON.stringify(tokenData), {
          headers: { "Content-Type": "application/json", ...CORS }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...CORS }
        });
      }
    }

    // POST /auth/refresh - refresh access token
    if (url.pathname === "/auth/refresh") {
      const { refreshToken } = body;
      if (!refreshToken) {
        return new Response(JSON.stringify({ error: "Missing refreshToken" }), {
          status: 400, headers: { "Content-Type": "application/json", ...CORS }
        });
      }

      try {
        const tokenData = await refreshAccessToken(refreshToken, env);
        return new Response(JSON.stringify(tokenData), {
          headers: { "Content-Type": "application/json", ...CORS }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...CORS }
        });
      }
    }

    // POST /drive/backup - upload snapshot
    if (url.pathname === "/drive/backup") {
      const { fileName, content, accessToken } = body;
      if (!fileName || !content || !accessToken) {
        return new Response(JSON.stringify({ error: "Missing fields" }), {
          status: 400, headers: { "Content-Type": "application/json", ...CORS }
        });
      }

      try {
        const result = await uploadSnapshot(fileName, content, accessToken);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", ...CORS }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...CORS }
        });
      }
    }

    // GET /drive/backups - list backups (accessToken in header)
    if (url.pathname === "/drive/backups") {
      const accessToken = request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!accessToken) {
        return new Response(JSON.stringify({ error: "Missing accessToken" }), {
          status: 401, headers: { "Content-Type": "application/json", ...CORS }
        });
      }

      try {
        const result = await listBackups(accessToken);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", ...CORS }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...CORS }
        });
      }
    }

    // GET /drive/restore/:fileId - get backup file content
    if (url.pathname.startsWith("/drive/restore/")) {
      const fileId = url.pathname.split("/").pop();
      const accessToken = request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!accessToken) {
        return new Response(JSON.stringify({ error: "Missing accessToken" }), {
          status: 401, headers: { "Content-Type": "application/json", ...CORS }
        });
      }

      try {
        const content = await getFileContent(fileId, accessToken);
        return new Response(content, {
          headers: { "Content-Type": "application/json", ...CORS }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...CORS }
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { "Content-Type": "application/json", ...CORS }
    });
  },
};
