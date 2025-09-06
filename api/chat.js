// api/chat.js (Vercel Function version of your original Node.js server)
import { GoogleGenerativeAI } from "@google/generative-ai";

// Gemini API key (store in Vercel Environment Variables)
const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

// In-memory sessions (reset on cold start)
let sessions = {};

// --- Helpers ---
function formatText(text) {
  if (!text) return "";
  return text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
}

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach(cookie => {
    let [name, ...rest] = cookie.split("=");
    name = name?.trim();
    if (!name) return;
    const value = rest.join("=");
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function newSessionId() {
  return Math.random().toString(36).substring(2);
}

async function askGemini(prompt, history) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const contents = [
      ...history.map(msg => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.text }]
      })),
      { role: "user", parts: [{ text: prompt }] }
    ];
    const result = await model.generateContent({ contents });
    return result.response.text();
  } catch (err) {
    console.error("Gemini API error:", err);
    return "(error contacting AI)";
  }
}

// --- HTML render ---
function renderChat(sessionId, history) {
  return `<!DOCTYPE html>
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
    <form method="POST" style="flex:1; display:flex; gap:5px;">
      <input type="hidden" name="sessionId" value="${sessionId}">
      <input type="text" name="prompt" placeholder="Type your message..." required>
      <button type="submit">Send</button>
    </form>
    <form method="POST">
      <input type="hidden" name="sessionId" value="${sessionId}">
      <input type="hidden" name="clear" value="1">
      <button type="submit">Clear History</button>
    </form>
  </div>

  <hr>
  <div>
    ${history
      .map(
        msg =>
          `<div class="message">
             <b>${msg.role === "user" ? "You" : "Bot"}:</b>
             <div class="bubble">${msg.text}</div>
           </div>`
      )
      .join("")}
  </div>
</body>
</html>`;
}

// --- Vercel function handler ---
export default async function handler(req, res) {
  const method = req.method;

  // Parse POST body
  let bodyParams = {};
  if (method === "POST") {
    const raw = await new Promise(r => {
      let data = "";
      req.on("data", chunk => data += chunk);
      req.on("end", () => r(data));
    });
    bodyParams = Object.fromEntries(new URLSearchParams(raw));
  }

  // Parse cookies
  const cookies = parseCookies(req);
  let sessionId = bodyParams.sessionId || req.query.sessionId || cookies.sessionId || newSessionId();

  if (!sessions[sessionId]) sessions[sessionId] = [];
  const history = sessions[sessionId];

  // Handle /clear
  if (bodyParams.clear) {
    sessions[sessionId] = [];
  }
  // Handle /ask
  else if (bodyParams.prompt) {
    const prompt = formatText(bodyParams.prompt);
    history.push({ role: "user", text: prompt });
    const reply = await askGemini(bodyParams.prompt, history);
    history.push({ role: "bot", text: formatText(reply) });
  }

  // Set session cookie
  res.setHeader("Set-Cookie", `sessionId=${sessionId}; Path=/`);

  // Render HTML
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.statusCode = 200;
  res.end(renderChat(sessionId, sessions[sessionId]));
}

