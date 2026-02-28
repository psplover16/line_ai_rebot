const ollaApiUrl = "http://localhost:11434/api/chat";
require("dotenv").config();
const iconv = require("iconv-lite");
const express = require("express");
const line = require("@line/bot-sdk");
const { execFile } = require("child_process");

const defaultAIModel = "qwen2.5:3b"; // 解析指令用的模型（輕量、速度快）
const highQualityAIModel = "qwen2.5:7b"; // 聊天用的模型（較重、回答品質較好）

const app = express();

// ====== 聊天記憶 ======
const conversations = new Map();
// key: userId
// value: [{role:"user", content:"..."}, {role:"assistant", content:"..."}]
const HISTORY_LIMIT = 20;

// ====== LINE ======
const lineConfig = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

let ALLOWED_USER_ID = (process.env.ALLOWED_USER_ID || "").trim();

// ====== Action 白名單 ======
const COMMANDS = {
  time: { file: "cmd.exe", args: ["/c", "time /t"] },
  list: { file: "cmd.exe", args: ["/c", "dir"] },
  reboot: { file: "shutdown.exe", args: ["-r", "-t", "0"] },
  openChrome: { file: "cmd.exe", args: ["/c", "start chrome"] },
};

const ALLOWED_ACTIONS = new Set([
  ...Object.keys(COMMANDS),
  "open_youtube_search",
  "none",
]);

// ====== Ollama 通用呼叫（/api/chat） ======
async function callModel(model, messages, { retries = 2 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(ollaApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages,
        }),
      });

      if (!res.ok) {
        console.log("Ollama HTTP error:", res.status);
        continue;
      }

      const data = await res.json();
      return (data.message?.content || "").trim();
    } catch (err) {
      console.log("Ollama network error:", err.message);
    }

    // 等 500ms 再重試
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error("Ollama failed after retries");
}

function safeParseJsonMaybe(raw) {
  const cleaned = (raw || "").replace(/```json|```/g, "").trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ====== YouTube 搜尋 ======
async function openYoutubeSearch(query) {
  if (!query) return;

  const encoded = encodeURIComponent(query);

  // 抓搜尋頁 HTML
  const res = await fetch(`https://www.youtube.com/results?search_query=${encoded}`);
  const html = await res.text();

  // 抓第一個影片ID
  const match = html.match(/"videoId":"(.*?)"/);

  if (!match) {
    console.log("找不到影片");
    return;
  }

  const videoId = match[1];
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}&autoplay=1`;

  execFile(
    "cmd.exe",
    ["/c", "chcp 65001>nul & start chrome", videoUrl],
    { windowsHide: true }
  );
}

// ====== LINE push ======
async function push(userId, text) {
  const client = new line.Client(lineConfig);
  try {
    return await client.pushMessage(userId, { type: "text", text });
  } catch (e) {
    console.error("LINE PUSH ERROR:", e.response?.data || e.message);
  }
}

// ====== Webhook ======
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  // 🔥 立刻回 200，避免 LINE replyToken / webhook timeout 問題
  res.sendStatus(200);

  try {
    const event = req.body.events?.[0];
    if (!event) return;

    if (event.type !== "message" || event.message.type !== "text") return;

    const userId = event.source?.userId || "";
    const text = (event.message.text || "").trim();

    console.log("USER:", userId);
    console.log("TEXT:", text);

    // 授權檢查
    if (!ALLOWED_USER_ID) {
      await push(userId, `請把這串 userId 貼進 .env：\n${userId}`);
      return;
    }
    if (userId !== ALLOWED_USER_ID) {
      await push(userId, "未授權的使用者");
      return;
    }

    // 取得歷史對話（聊天用）
    let history = conversations.get(userId) || [];

    // ====== 1) Parser：defaultAIModel 只負責意圖解析 ======
    const parserMessages = [
      {
        role: "system",
        content: `
你是「意圖解析器」。
你只能輸出「純 JSON」，不得輸出任何解釋、不得輸出 markdown、不得輸出多餘文字。

可用 action:
- time
- list
- reboot
- openChrome
- open_youtube_search
- none

規則：
1) 如果使用者是在要求電腦控制或開功能，回傳 action。
2) 如果使用者只是聊天或閒聊，回傳 {"action":"none"}。
3) open_youtube_search 時必須帶 search_query，例如：
{"action":"open_youtube_search","search_query":"周杰倫 稻香"}

只輸出 JSON。
        `.trim(),
      },
      { role: "user", content: text },
    ];

    const rawIntent = await callModel(defaultAIModel, parserMessages);
    console.log("PARSER RAW:", rawIntent);

    const intent = safeParseJsonMaybe(rawIntent);
    if (!intent || typeof intent !== "object") {
      await push(userId, "AI JSON 解析失敗（parser 回傳非 JSON）");
      return;
    }

    const action = String(intent.action || "").trim();
console.log('action',action);
    if (!ALLOWED_ACTIONS.has(action)) {
      await push(userId, "未知指令（不在白名單）");
      return;
    }

    // ====== 2) Action：open_youtube_search ======
    if (action === "open_youtube_search") {
      const q = String(intent.search_query || "").trim();
      if (!q) {
        await push(userId, "請提供要搜尋的 YouTube 關鍵字");
        return;
      }

      await openYoutubeSearch(q);

      // 可選：把 action 回覆也寫進 history（讓聊天上下文知道你做過什麼）
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: `（已執行）YouTube 搜尋：${q}` });
      if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
      conversations.set(userId, history);

      await push(userId, `已在 YouTube 搜尋：${q}`);
      return;
    }

    // ====== 3) Chat：highQualityAIModel 只負責聊天回答 ======
    if (action === "none") {
      const chatMessages = [
        {
          role: "system",
          content: `
你是一個自然、聰明、簡潔的助理。
請用繁體中文回答。
如果使用者是在要求「電腦控制」，請提醒他可以用明確指令（例如：開 Chrome、查時間、列出資料夾、重開機、YouTube 搜尋）。
          `.trim(),
        },
        ...history,
        { role: "user", content: text },
      ];

      const replyText = await callModel(highQualityAIModel, chatMessages);

      if (!replyText) {
        await push(userId, "AI 沒有回應");
        return;
      }

      // 更新記憶（只在真正聊天回覆後才寫入）
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: replyText });
      if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
      conversations.set(userId, history);

      await push(userId, replyText);
      return;
    }

    // ====== 4) Action：白名單命令 ======
    if (!COMMANDS[action]) {
      await push(userId, "未知指令（COMMANDS 未定義）");
      return;
    }

    execFile(
      COMMANDS[action].file,
      COMMANDS[action].args,
      {
        windowsHide: true,
        encoding: "buffer", // 必須是 buffer，下面用 iconv decode
      },
      async (err, stdout, stderr) => {
        try {
          if (err) {
            await push(userId, `執行失敗：${err.message}`);
            return;
          }

          const decoded = iconv.decode(stdout || stderr, "cp950").trim();
          console.log("DECODED:", decoded);

          // 可選：把 action 結果寫入 history
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: `（已執行）${action}\n${decoded}` });
          if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
          conversations.set(userId, history);

          await push(userId, decoded.slice(0, 1500) || `已執行：${action}`);
        } catch (e) {
          console.error(e);
        }
      }
    );
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Webhook listening on http://localhost:${PORT}`));