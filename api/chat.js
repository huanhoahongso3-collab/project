import { neon } from "@neondatabase/serverless";
import Cerebras from "@cerebras/cerebras_cloud_sdk";

// --- Neon DB connection ---
const sql = neon(process.env.DATABASE_URL);

// --- Cerebras client ---
const cerebras = new Cerebras({
  apiKey: process.env.CEREBRAS_API_KEY
});

// --- Helpers ---
function formatText(text) {
  return text?.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>") || "";
}

function newSessionId() {
  return Math.random().toString(36).substring(2);
}

function renderChat(history, sessionId) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Cerebras Chat</title>
<style>
body { font-family: sans-serif; max-width: 600px; margin: auto; }
form { margin-top: 10px; display:flex; gap:5px; }
input[type=text] { flex:1; padding:5px; }
button { padding:5px 10px; }
.message { margin: 8px 0; }
.bubble { white-space: pre-wrap; margin-left: 10px; }
</style>
</head>
<body>
<h2>Cerebras Chat</h2>
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
${history.map(msg => `
  <div class="message"><b>${msg.role === "user" ? "You" : "Bot"}:</b>
  <div class="bubble">${msg.text}</div></div>
`).join("")}
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
      (req.headers.cookie || "").split(";").map(c => {
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
    const history = dbHistory.map(h => ({ role: h.role, text: h.text }));

    if (req.method === "POST") {
      const body = await new Promise(resolve => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => resolve(data));
      });

      const params = new URLSearchParams(body);
      const prompt = params.get("prompt");

      if (prompt?.trim()) {
        const formattedPrompt = formatText(prompt);

        // Insert user message into DB
        await sql`
          INSERT INTO chat_history (session_id, role, text)
          VALUES (${sessionId}, 'user', ${formattedPrompt})
        `;
        history.push({ role: "user", text: formattedPrompt });

        // Call Cerebras GPT-OSS-120B (streamed)
        let replyText = "";
        const stream = await cerebras.chat.completions.create({
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            ...history.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.text })),
            { role: "user", content: prompt }
          ],
          model: "gpt-oss-120b",
          stream: true,
          max_completion_tokens: 65536, // For testing; can be increased
          temperature: 0.7,
          top_p: 0.6,
          reasoning_effort: "medium"
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content || "";
          replyText += delta;
        }

        const formattedReply = formatText(replyText);

        // Insert bot reply into DB
        await sql`
          INSERT INTO chat_history (session_id, role, text)
          VALUES (${sessionId}, 'bot', ${formattedReply})
        `;
        history.push({ role: "bot", text: formattedReply });

        return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(renderChat(history, sessionId));
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
