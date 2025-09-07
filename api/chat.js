import { neon } from "@neondatabase/serverless";

// --- Neon DB connection ---
const sql = neon(process.env.DATABASE_URL);

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
<title>Puter GPT-5 Chat</title>
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
<h2>Puter GPT-5 Chat</h2>

<div style="display:flex; gap:10px; align-items:flex-start; margin-bottom:10px;">
  <form id="chat-form" style="flex:1; display:flex; gap:5px;">
    <input type="text" id="prompt" placeholder="Type your message..." required>
    <button type="submit">Send</button>
  </form>
  <button id="clear-btn">Clear History</button>
</div>

<hr>
<div id="chat-window">
${history.map(msg => `
  <div class="message"><b>${msg.role === "user" ? "You" : "Bot"}:</b>
  <div class="bubble">${msg.text}</div></div>
`).join("")}
</div>

<script src="https://js.puter.com/v2/"></script>
<script>
const chatWindow = document.getElementById("chat-window");
const chatForm = document.getElementById("chat-form");
const promptInput = document.getElementById("prompt");
const clearBtn = document.getElementById("clear-btn");

let chatHistory = ${JSON.stringify(history)};

// Helper to render chat
function renderChatClient() {
  chatWindow.innerHTML = chatHistory.map(msg => \`
    <div class="message"><b>\${msg.role === "user" ? "You" : "Bot"}:</b>
    <div class="bubble">\${msg.text}</div></div>
  \`).join("");
}

// Handle sending message
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  chatHistory.push({ role: "user", text: prompt });
  renderChatClient();
  promptInput.value = "";

  // Generate AI response using Puter.js
  try {
    const response = await puter.ai.chat(prompt, { model: "gpt-5-nano" });
    chatHistory.push({ role: "bot", text: response });
    renderChatClient();

    // Save user and bot messages to DB
    fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "${sessionId}", messages: chatHistory.slice(-2) })
    });

  } catch (err) {
    console.error(err);
    chatHistory.push({ role: "bot", text: "(error contacting AI)" });
    renderChatClient();
  }
});

// Clear chat
clearBtn.addEventListener("click", () => {
  chatHistory = [];
  renderChatClient();
  fetch("/?clear=1", { method: "POST" });
});
</script>
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

    // Save messages sent from client
    if (req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      await new Promise(resolve => req.on("end", resolve));

      try {
        const data = JSON.parse(body);
        if (data.messages?.length) {
          for (const msg of data.messages) {
            await sql`
              INSERT INTO chat_history (session_id, role, text)
              VALUES (${sessionId}, ${msg.role}, ${msg.text})
            `;
          }
        }
      } catch (_) {}
    }

    // Retrieve chat history
    const dbHistory = await sql`
      SELECT role, text FROM chat_history
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
    `;
    const history = dbHistory.map(h => ({ role: h.role, text: h.text }));

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderChat(history, sessionId));

  } catch (err) {
    console.error("Server error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}
