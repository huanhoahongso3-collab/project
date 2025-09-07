// api/chat.js
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const SESSIONS_DIR = path.resolve(".sessions"); // store session files

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Helpers ---
function formatText(text) {
  if (!text) return "";
  return text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach(cookie => {
    let [name, ...rest] = cookie.split("=");
    name = name?.trim();
    if (!name) return;
    list[name] = decodeURIComponent(rest.join("="));
  });
  return list;
}

function newSessionId() {
  return Math.random().toString(36).substring(2);
}

function getSessionFile(sessionId) {
  return path.join(SESSIONS_DIR, sessionId + ".json");
}

function getHistory(sessionId) {
  const file = getSessionFile(sessionId);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(sessionId, history) {
  fs.writeFileSync(getSessionFile(sessionId), JSON.stringify(history, null, 2));
}

async function askGemini(prompt, history) {
  const contents = [
    ...history.map(msg => ({ role: msg.role, parts: [{ text: msg.text }] })),
    { role: "user", parts: [{ text: prompt }] }
  ];
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": GEMINI_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ contents })
      }
    );
    const data = await res.json();
    return data?.candidates?.[0]?.content?.[0]?.text || "(no response)";
  } catch (err) {
    console.error("Gemini API error:", err);
    return "(error contacting AI)";
  }
}

function renderChat(history) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>Gemini Chatbot</title>
    <style>
      body { font-family: sans-serif; max-width: 600px; margin: auto; }
      form { margin-top: 10px; }
      input[type=text] { flex: 1; padding: 5px; }
      button { padding: 5px 10px; }
      .message { margin: 8px 0; }
      .bubble { white-space: pre-wrap; margin-left: 10px; }
    </style>
  </head>
  <body>
    <h2>Gemini Chatbot</h2>
    <div style="display:flex; gap:10px; align-items:flex-start; margin-bottom:10px;">
      <form method="post" action="/api/chat" style="flex:1; display:flex; gap:5px;">
        <input type="text" name="prompt" placeholder="Type your message..." required>
        <button type="submit">Send</button>
      </form>
      <form method="post" action="/api/chat?clear=1">
        <button type="submit">Clear History</button>
      </form>
    </div>
    <hr>
    <div>
      ${history
        .map(
          msg => `<div class="message">
                    <b>${msg.role === "user" ? "You" : "Bot"}:</b>
                    <div class="bubble">${msg.text}</div>
                  </div>`
        )
        .join("")}
    </div>
  </body>
  </html>
  `;
}

// --- Serverless handler ---
export default async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sessionId = cookies.sessionId || newSessionId();

  let history = getHistory(sessionId);

  if (req.method === "POST" && req.url.includes("clear")) {
    history = [];
    saveHistory(sessionId, history);
    res.setHeader("Set-Cookie", `sessionId=${sessionId}; Path=/`);
    return res.writeHead(302, { Location: "/api/chat" }).end();
  }

  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const prompt = params.get("prompt");

    history.push({ role: "user", text: formatText(prompt) });
    const reply = await askGemini(prompt, history);
    history.push({ role: "bot", text: formatText(reply) });
    saveHistory(sessionId, history);

    res.setHeader("Set-Cookie", `sessionId=${sessionId}; Path=/`);
    return res.writeHead(302, { Location: "/api/chat" }).end();
  }

  // GET → render HTML
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderChat(history));
}
