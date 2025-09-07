import { neon } from "@neondatabase/serverless";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const sql = neon(process.env.DATABASE_URL);

// --- Helpers ---
function formatText(text) {
  return text?.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>") || "";
}

function newSessionId() {
  return Math.random().toString(36).substring(2);
}

// --- Gemini API ---
async function askGemini(prompt, history) {
  try {
    const contents = [
      ...history.map((msg) => ({
        role: msg.role === "user" ? "user" : "assistant",
        parts: [{ text: msg.text }],
      })),
      { role: "user", parts: [{ text: prompt }] },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
    });

    return response.text || "(no response)";
  } catch (err) {
    console.error("Gemini API error:", err);
    return "(error contacting AI)";
  }
}

// --- HTML render ---
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
${history.map(
    (msg) =>
      `<div class="message"><b>${
        msg.role === "user" ? "You" : "Bot"
      }:</b><div class="bubble">${msg.text}</div></div>`
  ).join("")}
</div>
</body>
</html>
`;
}

// --- Serverless handler ---
export default async function handler(req, res) {
  // Parse cookies
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => {
      const [k, ...v] = c.split("=");
      return [k?.trim(), decodeURIComponent(v.join("="))];
    })
  );
  let sessionId = cookies.sessionId || newSessionId();

  // Clear history
  if (req.method === "POST" && req.url.includes("clear")) {
    await sql`DELETE FROM chat_history WHERE session_id = ${sessionId}`;
    res.setHeader("Set-Cookie", `sessionId=${sessionId}; Path=/`);
    return res.writeHead(302, { Location: "/api/chat" }).end();
  }

  // Retrieve chat history
  const dbHistory = await sql`
    SELECT role, text FROM chat_history
    WHERE session_id = ${sessionId}
    ORDER BY created_at ASC
  `;
  const history = dbHistory.map((h) => ({ role: h.role, text: h.text }));

  // Handle user input
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const prompt = params.get("prompt");

    const chatHistory = [...history, { role: "user", text: formatText(prompt) }];

    // Generate AI response with last 10 messages
    const reply = await askGemini(prompt, chatHistory.slice(-10));
    chatHistory.push({ role: "bot", text: formatText(reply) });

    // Insert user message and bot reply into DB
    for (const msg of chatHistory.slice(-2)) {
      await sql`
        INSERT INTO chat_history (session_id, role, text)
        VALUES (${sessionId}, ${msg.role}, ${msg.text})
      `;
    }

    res.setHeader("Set-Cookie", `sessionId=${sessionId}; Path=/`);
    return res.writeHead(302, { Location: "/api/chat" }).end();
  }

  // GET → render chat page
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderChat(history));
}
