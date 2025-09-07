import { neon } from "@neondatabase/serverless";
import { GoogleGenAI } from "@google/genai";

// --- Neon DB connection ---
const sql = neon(process.env.DATABASE_URL);

// --- Gemini API ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- Helpers ---
function formatText(text) {
  return text?.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>") || "";
}

function newSessionId() {
  return Math.random().toString(36).substring(2);
}

async function askGemini(prompt, history) {
  try {
    // Use 'user' and 'model' only for roles
    const contents = [
      ...history.map((msg) => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.text }],
      })),
      { role: "user", parts: [{ text: prompt }] },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents,
    });

    return response.text || "(no response)";
  } catch (err) {
    console.error("Gemini API error:", err);
    return "(error contacting AI)";
  }
}

function renderChat(history, sessionId) {
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
<form method="post" action="/" style="flex:1; display:flex; gap:5px;">
<input type="text" name="prompt" placeholder="Type your message..." required>
<button type="submit">Send</button>
</form>
<form method="post" action="/?clear=1">
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
  try {
    // Parse cookies
    const cookies = Object.fromEntries(
      (req.headers.cookie || "")
        .split(";")
        .map((c) => {
          const [k, ...v] = c.split("=");
          return [k?.trim(), decodeURIComponent(v.join("="))];
        })
    );

    let sessionId = cookies.sessionId || newSessionId();
    res.setHeader("Set-Cookie", `sessionId=${sessionId}; Path=/`);

    // Clear history
    if (req.method === "POST" && req.url.includes("clear")) {
      await sql`DELETE FROM chat_history WHERE session_id = ${sessionId}`;
      return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(renderChat([], sessionId));
    }

    // Retrieve chat history
    const dbHistory = await sql`
      SELECT role, text FROM chat_history
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
    `;
    const history = dbHistory.map((h) => ({ role: h.role, text: h.text }));

    if (req.method === "POST") {
      const body = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      const params = new URLSearchParams(body);
      const prompt = params.get("prompt");

      if (prompt?.trim()) {
        // Limit AI context to last 10 messages
        const chatHistory = [...history, { role: "user", text: formatText(prompt) }];
        const reply = await askGemini(prompt, chatHistory.slice(-10));
        chatHistory.push({ role: "model", text: formatText(reply) });

        // Insert last 2 messages (user + bot) into DB
        for (const msg of chatHistory.slice(-2)) {
          await sql`
            INSERT INTO chat_history (session_id, role, text)
            VALUES (${sessionId}, ${msg.role}, ${msg.text})
          `;
        }

        // Render updated chat
        return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(renderChat(chatHistory, sessionId));
      }
    }

    // GET → render chat page
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderChat(history, sessionId));
  } catch (err) {
    console.error("Server error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}
