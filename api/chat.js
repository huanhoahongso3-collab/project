import { neon } from "@neondatabase/serverless";
import { GoogleGenAI } from "@google/genai";

// --- Neon DB connection ---
const sql = neon(process.env.DATABASE_URL);

// --- Gemini AI ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- Helpers ---
function formatText(text) {
  return text?.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>") || "";
}

function newSessionId() {
  return Math.random().toString(36).substring(2);
}

// Ask Gemini AI
async function askGemini(prompt, history) {
  try {
    const contents = [
      ...history.slice(-10).map(msg => ({
        role: msg.role === "user" ? "user" : "assistant",
        parts: [{ text: msg.text }],
      })),
      { role: "user", parts: [{ text: prompt }] },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
    });

    console.log("Gemini raw response:", JSON.stringify(response, null, 2));

    // Safely extract all text from first candidate
    const text = response?.candidates?.[0]?.content
      ?.map(part => part.text)
      .filter(Boolean)
      .join("") || "(no response)";

    return text;
  } catch (err) {
    console.error("Gemini API error:", err.response?.data || err);
    return "(error contacting AI)";
  }
}

// Render HTML page
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
    msg =>
      `<div class="message"><b>${msg.role === "user" ? "You" : "Bot"}:</b><div class="bubble">${msg.text}</div></div>`
  )
  .join("")}
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
        .map(c => {
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
    const history = dbHistory.map(h => ({ role: h.role, text: h.text }));

    // Handle new message
    if (req.method === "POST") {
      const body = await new Promise(resolve => {
        let data = "";
        req.on("data", chunk => (data += chunk));
        req.on("end", () => resolve(data));
      });

      const params = new URLSearchParams(body);
      const prompt = params.get("prompt")?.trim();
      if (!prompt) return res.writeHead(302, { Location: "/api/chat" }).end();

      // Prepare history for AI
      const aiInputHistory = [...history, { role: "user", text: prompt }];

      // Ask Gemini
      const reply = await askGemini(prompt, aiInputHistory);

      // Store user + AI messages
      await sql`
        INSERT INTO chat_history (session_id, role, text)
        VALUES (${sessionId}, 'user', ${prompt})
      `;
      await sql`
        INSERT INTO chat_history (session_id, role, text)
        VALUES (${sessionId}, 'bot', ${reply})
      `;

      res.setHeader("Set-Cookie", `sessionId=${sessionId}; Path=/`);
      return res.writeHead(302, { Location: "/api/chat" }).end();
    }

    // GET → render page
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderChat(history));
  } catch (err) {
    console.error("Server error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}
