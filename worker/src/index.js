// linquiz API worker — Gemini 出題代理
// - BYOK：使用者可在前端填自己的 Key（X-Gemini-Api-Key），用他自己的 Key 呼叫，不受冷卻限制
// - 沒填 Key 時用伺服器內建的 Key 池，支援多組 Gemini API Key 輪換：
//   env.GEMINI_API_KEYS 用逗號分隔多組 Key（單組時退回用 env.GEMINI_API_KEY），
//   失敗自動換下一組 Key，全部 Key 都試完再換下一個模型
// - 走內建 Key 池時，以來源 IP 為單位，透過 KV 限制每次「開始出題」動作 30 秒冷卻
// - 同一次出題的多個批次 (X-Batch-Index > 0) 不重複計算冷卻，避免大題數被自己卡住
// - 帶入正確的管理者密碼 (X-Admin-Pass) 可略過冷卻限制
// - 模型比照 lunslip 專案做雙模型容錯：gemini-3.5-flash 失敗（額度滿/模型暫時異常）
//   就自動 fallback 到 gemini-3.1-flash-lite，不會整批直接失敗

const COOLDOWN_MS = 30000;
const DEFAULT_ADMIN_PASSWORD = "5407";
const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Pass, X-Batch-Index, X-Gemini-Api-Key",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate") {
      return handleGenerate(request, env);
    }
    if (url.pathname === "/api/visit") {
      return handleVisit(request, env);
    }
    if (url.pathname === "/api/keys-check") {
      return handleKeysCheck(request, env);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    return new Response("linquiz API worker is running.", { status: 200 });
  },
};

// 真實瀏覽人次計數：以「來源IP + 當天日期」去重，同一人同一天重整頁面不會重複累加，
// 隔天再訪問才會再算一次。計數存在既有的 COOLDOWN_KV（key 前綴 visit:）。
async function handleVisit(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const dedupeKey = `visited:${ip}:${today}`;
  const countKey = "visit_count";

  const alreadyVisited = await env.COOLDOWN_KV.get(dedupeKey);
  let count = parseInt((await env.COOLDOWN_KV.get(countKey)) || "0", 10);

  if (!alreadyVisited) {
    count += 1;
    await env.COOLDOWN_KV.put(countKey, String(count));
    await env.COOLDOWN_KV.put(dedupeKey, "1", { expirationTtl: 86400 });
  }

  return new Response(JSON.stringify({ count }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// 管理者診斷用：逐一測試 GEMINI_API_KEYS 池裡每組 Key 是否有效（呼叫輕量的 models list，不耗生成額度）。
// 需帶正確的 X-Admin-Pass，回應只顯示 Key 末4碼，不洩漏完整金鑰。
async function handleKeysCheck(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const adminPass = request.headers.get("X-Admin-Pass") || "";
  const expectedAdminPass = env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  if (adminPass === "" || adminPass !== expectedAdminPass) {
    return new Response(JSON.stringify({ error: { message: "需要管理者密碼" } }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const apiKeys = getApiKeys(env);
  const results = [];

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    const last4 = apiKey.slice(-4);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
      );
      const data = await res.json();
      if (data.error) {
        results.push({ index: i, last4, ok: false, error: data.error.message });
      } else {
        results.push({ index: i, last4, ok: true });
      }
    } catch (err) {
      results.push({ index: i, last4, ok: false, error: err.message });
    }
  }

  return new Response(JSON.stringify({ total: apiKeys.length, results }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function getApiKeys(env) {
  const raw = env.GEMINI_API_KEYS || env.GEMINI_API_KEY || "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

async function handleGenerate(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  }

  try {
    const adminPass = request.headers.get("X-Admin-Pass") || "";
    const batchIndex = parseInt(request.headers.get("X-Batch-Index") || "0", 10);
    const expectedAdminPass = env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    const isAdmin = adminPass !== "" && adminPass === expectedAdminPass;
    const userApiKey = (request.headers.get("X-Gemini-Api-Key") || "").trim();
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    // 使用者自帶 Key（BYOK）時，用量算他自己的，跳過冷卻。
    // 只有走伺服器內建 Key 池時，才需要在每次出題的第一批 (batchIndex === 0) 檢查冷卻，
    // 讓同一次出題內續抓後續批次不會被自己的冷卻卡住。
    if (!isAdmin && !userApiKey && batchIndex === 0) {
      const cooldownKey = `cooldown:${ip}`;
      const lastTs = await env.COOLDOWN_KV.get(cooldownKey);
      const now = Date.now();

      if (lastTs) {
        const elapsed = now - parseInt(lastTs, 10);
        if (elapsed < COOLDOWN_MS) {
          const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
          return new Response(
            JSON.stringify({ error: { code: "COOLDOWN", remaining } }),
            {
              status: 429,
              headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Retry-After": String(remaining) },
            }
          );
        }
      }

      await env.COOLDOWN_KV.put(cooldownKey, String(now), { expirationTtl: 60 });
    }

    const apiKeys = userApiKey ? [userApiKey] : getApiKeys(env);
    if (apiKeys.length === 0) {
      throw new Error("未提供 API Key，且伺服器未設定 GEMINI_API_KEYS / GEMINI_API_KEY（請以 wrangler secret put 設定）");
    }

    const payload = await request.json();
    const requestBody = JSON.stringify({
      contents: payload.contents,
      generationConfig: payload.generationConfig || {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
      },
    });

    // 每次請求隨機挑一個起始 Key，讓多組 Key 的用量平均分散，
    // 而不是永遠先打第一組（第一組額度用完前，後面的 Key 都閒置）。
    const startIdx = Math.floor(Math.random() * apiKeys.length);

    let data = null;
    let lastError = null;

    outer: for (const model of GEMINI_MODELS) {
      for (let i = 0; i < apiKeys.length; i++) {
        const apiKey = apiKeys[(startIdx + i) % apiKeys.length];
        const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        try {
          const googleRes = await fetch(googleUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
          });
          const resData = await googleRes.json();
          if (resData.error) {
            lastError = resData.error;
            continue;
          }
          data = resData;
          break outer;
        } catch (err) {
          lastError = { message: err.message };
        }
      }
    }

    if (!data) {
      return new Response(JSON.stringify({ error: lastError || { message: "所有 Key／模型皆呼叫失敗" } }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: err.message } }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}
