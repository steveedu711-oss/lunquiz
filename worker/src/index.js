// linquiz API worker — Gemini 出題代理
// - BYOK：使用者可在前端填自己的 Key（X-Gemini-Api-Key），用他自己的 Key 呼叫，不受冷卻限制
// - 沒填 Key 時用伺服器內建的 Key 池，支援多組 Gemini API Key 輪換：
//   env.GEMINI_API_KEYS 用逗號分隔多組 Key（單組時退回用 env.GEMINI_API_KEY），
//   失敗自動換下一組 Key，全部 Key 都試完再換下一個模型
// - 走內建 Key 池時，以「瀏覽器裝置 ID」(X-Client-Id，前端 localStorage 產生的隨機值) 為單位，
//   透過 KV 限制每次「開始出題」動作 30 秒冷卻；沒帶裝置ID的舊前端才退回用來源IP判斷，
//   避免同一所學校/同一個網路出口的多位老師互相卡到彼此的冷卻
// - 同一次出題的多個批次 (X-Batch-Index > 0) 不重複計算冷卻，避免大題數被自己卡住
// - 帶入正確的管理者密碼 (X-Admin-Pass) 可略過冷卻限制
// - 模型比照 lunslip 專案做雙模型容錯：gemini-3.5-flash 失敗（額度滿/模型暫時異常）
//   就自動 fallback 到 gemini-3.1-flash-lite，不會整批直接失敗

const COOLDOWN_MS = 30000;
const DEFAULT_ADMIN_PASSWORD = "5407";
const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
const SHARE_TTL_SECONDS = 60 * 60 * 24 * 30; // 分享連結30天後過期
const SHARE_MAX_BYTES = 500 * 1024; // 單份分享內容上限500KB,避免濫用KV空間
const RESULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 作答結果連結30天後過期
const RESULT_MAX_BYTES = 300 * 1024; // 單份結果內容上限300KB
const LIVE_PROGRESS_TTL_SECONDS = 60 * 60 * 8; // 即時進度8小時後自動過期(教室情境用不到這麼久)
const LIVE_PROGRESS_DAILY_WRITE_CAP = 400; // 這個功能自己保留的每日KV寫入預算,見live-budget:計數key
const LIVE_BUDGET_TTL_SECONDS = 60 * 60 * 25; // 25小時,每天自動歸零(比24小時多留緩衝)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Pass, X-Batch-Index, X-Gemini-Api-Key, X-Client-Id",
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
    if (url.pathname === "/api/share" && request.method !== "GET") {
      return handleShareCreate(request, env);
    }
    if (url.pathname.startsWith("/api/share/")) {
      return handleShareGet(request, env, url.pathname.slice("/api/share/".length));
    }
    if (url.pathname === "/api/result" && request.method !== "GET") {
      return handleResultCreate(request, env);
    }
    if (url.pathname.startsWith("/api/result/")) {
      return handleResultGet(request, env, url.pathname.slice("/api/result/".length));
    }
    if (url.pathname === "/api/live-progress" && request.method !== "GET") {
      return handleLiveProgressPost(request, env);
    }
    if (url.pathname.startsWith("/api/live-progress/")) {
      const rest = url.pathname.slice("/api/live-progress/".length).split("/").filter(Boolean);
      if (rest.length === 1) return handleLiveProgressList(request, env, rest[0]);
      return handleLiveProgressGet(request, env, rest[0], rest[1]);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    return new Response("linquiz API worker is running.", { status: 200 });
  },
};

// 分享功能：老師出完題後把題目存進KV,產生短ID,分享給學生(線上作答)或家長(答案卷)。
// 存在既有的 COOLDOWN_KV(key 前綴 share:),30天後自動過期(expirationTtl)。
async function handleShareCreate(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: { message: "Method Not Allowed" } }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json();
    const items = body.items;
    const title = String(body.title || "測驗").slice(0, 200);

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: { message: "沒有題目內容可以分享" } }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const payload = JSON.stringify({ items, title, createdAt: Date.now() });
    if (payload.length > SHARE_MAX_BYTES) {
      return new Response(JSON.stringify({ error: { message: "題目內容太大，無法分享（請減少題數）" } }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await env.COOLDOWN_KV.put("share:" + id, payload, { expirationTtl: SHARE_TTL_SECONDS });

    return new Response(JSON.stringify({ id }), {
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

async function handleShareGet(request, env, id) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (!id) {
    return new Response(JSON.stringify({ error: { message: "缺少分享ID" } }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const raw = await env.COOLDOWN_KV.get("share:" + id);
  if (!raw) {
    return new Response(JSON.stringify({ error: { message: "找不到這份分享內容，可能已過期(30天)或連結錯誤" } }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(raw, {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// 學生線上作答完成後，把評分結果(含選填的學生資料)存進KV,產生短ID,
// 讓學生可以複製連結分享給家長/老師查看(唯讀,不可重測)。存在既有的 COOLDOWN_KV(key前綴 result:),30天後過期。
// 跟 /api/share 一樣沒有身分驗證，僅限存放「已作答完的結果摘要」，不接受任意大小內容(300KB上限)。
async function handleResultCreate(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: { message: "Method Not Allowed" } }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json();
    const details = body.details;
    if (!Array.isArray(details) || details.length === 0) {
      return new Response(JSON.stringify({ error: { message: "沒有作答結果可以分享" } }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const payload = JSON.stringify({
      title: String(body.title || "測驗").slice(0, 200),
      studentInfo: {
        grade: String((body.studentInfo && body.studentInfo.grade) || "").slice(0, 50),
        className: String((body.studentInfo && body.studentInfo.className) || "").slice(0, 50),
        seat: String((body.studentInfo && body.studentInfo.seat) || "").slice(0, 20),
        name: String((body.studentInfo && body.studentInfo.name) || "").slice(0, 50),
      },
      totalScore: Number(body.totalScore) || 0,
      maxScore: Number(body.maxScore) || 0,
      pct: Number(body.pct) || 0,
      details,
      createdAt: Date.now(),
    });

    if (payload.length > RESULT_MAX_BYTES) {
      return new Response(JSON.stringify({ error: { message: "作答結果內容太大，無法分享" } }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await env.COOLDOWN_KV.put("result:" + id, payload, { expirationTtl: RESULT_TTL_SECONDS });

    return new Response(JSON.stringify({ id }), {
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

async function handleResultGet(request, env, id) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (!id) {
    return new Response(JSON.stringify({ error: { message: "缺少結果ID" } }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const raw = await env.COOLDOWN_KV.get("result:" + id);
  if (!raw) {
    return new Response(JSON.stringify({ error: { message: "找不到這份作答結果，可能已過期(30天)或連結錯誤" } }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(raw, {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// 即時進度：學生線上作答時，答題狀態每次真的改變(而不是定時)才推送一次進度，
// 老師可以開儀表板看全班進度、家長可以看自己小孩單人進度。
// key: live:{shareId}:{studentId}，shareId直接沿用/api/share產生的ID(不用另外設計「批次」)，
// value存完整進度(給家長單人查看)，metadata存精簡摘要(老師儀表板list()時直接拿，不用逐一get())。
// 8小時後自動過期。另外用 live-budget:{今天日期} 計數key做每日寫入預算保護——
// Cloudflare KV免費方案每天只有1000次寫入額度，這個功能跟其他既有功能(冷卻/分享/分享結果/訪客數)
// 共用同一個COOLDOWN_KV，設一個明顯低於1000的自我上限，超過就靜默停止寫入(不報錯)，
// 避免這個錦上添花的新功能把其他既有功能的額度也一起吃光。
async function handleLiveProgressPost(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: { message: "Method Not Allowed" } }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json();
    const shareId = String(body.shareId || "").trim();
    const studentId = String(body.studentId || "").trim();
    if (!shareId || !studentId) {
      return new Response(JSON.stringify({ error: { message: "缺少shareId或studentId" } }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const budgetKey = "live-budget:" + today;
    const budgetUsed = parseInt((await env.COOLDOWN_KV.get(budgetKey)) || "0", 10);
    if (budgetUsed >= LIVE_PROGRESS_DAILY_WRITE_CAP) {
      // 靜默停止,不算錯誤:學生作答本身完全不受影響,只是老師/家長那邊這次看不到最新進度
      return new Response(JSON.stringify({ throttled: true }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const studentInfo = {
      grade: String((body.studentInfo && body.studentInfo.grade) || "").slice(0, 50),
      className: String((body.studentInfo && body.studentInfo.className) || "").slice(0, 50),
      seat: String((body.studentInfo && body.studentInfo.seat) || "").slice(0, 20),
      name: String((body.studentInfo && body.studentInfo.name) || "").slice(0, 50),
    };
    const answered = Number(body.answered) || 0;
    const total = Number(body.total) || 0;
    const updatedAt = Date.now();

    const payload = JSON.stringify({ shareId, studentId, studentInfo, answered, total, updatedAt });

    await env.COOLDOWN_KV.put(budgetKey, String(budgetUsed + 1), { expirationTtl: LIVE_BUDGET_TTL_SECONDS });
    await env.COOLDOWN_KV.put("live:" + shareId + ":" + studentId, payload, {
      expirationTtl: LIVE_PROGRESS_TTL_SECONDS,
      metadata: { ...studentInfo, answered, total, updatedAt },
    });

    return new Response(JSON.stringify({ ok: true }), {
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

// 老師儀表板用：列出這個shareId底下所有學生目前進度。會洩漏全班姓名+分數，
// 敏感度比單人分享連結高，需要管理者密碼(比照handleKeysCheck的驗證寫法)。
async function handleLiveProgressList(request, env, shareId) {
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
  if (!shareId) {
    return new Response(JSON.stringify({ error: { message: "缺少shareId" } }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const list = await env.COOLDOWN_KV.list({ prefix: "live:" + shareId + ":" });
  const students = list.keys.map((k) => ({
    studentId: k.name.slice(("live:" + shareId + ":").length),
    ...(k.metadata || {}),
  }));

  return new Response(JSON.stringify({ students }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// 家長單人視角：跟/api/share、/api/result一樣是capability-URL哲學,知道shareId+studentId
// 這組組合ID才看得到,不需要額外密碼驗證。
async function handleLiveProgressGet(request, env, shareId, studentId) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (!shareId || !studentId) {
    return new Response(JSON.stringify({ error: { message: "缺少shareId或studentId" } }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const raw = await env.COOLDOWN_KV.get("live:" + shareId + ":" + studentId);
  if (!raw) {
    return new Response(JSON.stringify({ error: { message: "找不到這位學生的即時進度，可能還沒開始作答或已過期(8小時)" } }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(raw, {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

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
    const clientId = (request.headers.get("X-Client-Id") || "").trim();

    // 使用者自帶 Key（BYOK）時，用量算他自己的，跳過冷卻。
    // 只有走伺服器內建 Key 池時，才需要在每次出題的第一批 (batchIndex === 0) 檢查冷卻，
    // 讓同一次出題內續抓後續批次不會被自己的冷卻卡住。
    // 冷卻以裝置ID為主、IP為備援，避免同校/同網路多位老師互相卡到彼此的冷卻。
    if (!isAdmin && !userApiKey && batchIndex === 0) {
      const cooldownKey = `cooldown:${clientId || ip}`;
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
        // 原本8192太容易被題數多/計算解析題較長的輸出截斷,導致JSON陣列沒收尾解析失敗
        // (Steve回報「AI回傳的內容無法解析成題目格式」常出現),提高上限降低截斷機率
        maxOutputTokens: 32768,
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
