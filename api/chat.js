const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Helpers ---
function formatText(text) {
  return text?.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>") || "";
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach(cookie => {
    const [name, ...rest] = cookie.split("=");
    if (!name) return;
    list[name.trim()] = decodeURIComponent(rest.join("="));
  });
  return list;
}

function newSessionId() {
  return Math.random().toString(36).substring(2);
}

function encodeHistory(history) {
  return encodeURIComponent(JSON.stringify(history));
}

function decodeHistory(cookieValue) {
  try {
    return JSON.parse(decodeURIComponent(cookieValue)) || [];
  } catch {
    return [];
  }
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
    console.log("Gemini API response:", JSON.stringify(data, null, 2));

    // Find output_text in content
    return (
      data?.candidates?.[0]?.content?.find(c => c.type === "output_text")?.text ||
      "(no response)"
    );
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
      msg =>
        `<div class="message"><b>${
          msg.role === "user" ? "You" : "Bot"
        }:</b><div class="bubble">${msg.text}</div></div>`
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

  // Load history from cookie
  let history = cookies[`history_${sessionId}`]
    ? decodeHistory(cookies[`history_${sessionId}`])
    : [];

  // Clear history
  if (req.method === "POST" && req.url.includes("clear")) {
    history = [];
    res.setHeader("Set-Cookie", [
      `sessionId=${sessionId}; Path=/`,
      `history_${sessionId}=; Path=/; Max-Age=0`
    ]);
    return res.writeHead(302, { Location: "/api/chat" }).end();
  }

  // Handle user prompt
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    const prompt = params.get("prompt");

    history.push({ role: "user", text: formatText(prompt) });
    const reply = await askGemini(prompt, history);
    history.push({ role: "bot", text: formatText(reply) });

    // Save history in cookie
    res.setHeader("Set-Cookie", [
      `sessionId=${sessionId}; Path=/`,
      `history_${sessionId}=${encodeHistory(history)}; Path=/; HttpOnly`
    ]);

    return res.writeHead(302, { Location: "/api/chat" }).end();
  }

  // GET → render HTML
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderChat(history));
}
