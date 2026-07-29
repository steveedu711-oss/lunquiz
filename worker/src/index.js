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
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 登入session 30天後需要重新登入
const HISTORY_MAX_PER_CLASS = 50; // 每個班級最多存50份出題歷史,超過自動刪最舊的

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Pass, X-Batch-Index, X-Gemini-Api-Key, X-Client-Id, X-Session-Token, X-Dash-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

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
    if (url.pathname === "/api/code" && request.method === "POST") {
      return handleCodeCreate(request, env);
    }
    if (url.pathname.startsWith("/api/code/")) {
      return handleCodeLookup(request, env, url.pathname.slice("/api/code/".length));
    }
    if (url.pathname === "/api/live-revoke") {
      return handleLiveRevoke(request, env);
    }
    if (url.pathname === "/api/live-progress" && request.method !== "GET") {
      return handleLiveProgressPost(request, env);
    }
    if (url.pathname.startsWith("/api/live-progress/")) {
      const rest = url.pathname.slice("/api/live-progress/".length).split("/").filter(Boolean);
      if (rest.length === 1) return handleLiveProgressList(request, env, rest[0]);
      return handleLiveProgressGet(request, env, rest[0], rest[1]);
    }
    if (url.pathname === "/api/auth/register") {
      return handleAuthRegister(request, env);
    }
    if (url.pathname === "/api/auth/login") {
      return handleAuthLogin(request, env);
    }
    if (url.pathname === "/api/auth/me") {
      return handleAuthMe(request, env);
    }
    if (url.pathname === "/api/auth/join-class") {
      return handleAuthJoinClass(request, env);
    }
    if (url.pathname === "/api/history" && request.method === "GET") {
      return handleHistoryList(request, env);
    }
    if (url.pathname === "/api/history") {
      return handleHistoryCreate(request, env);
    }
    if (url.pathname.startsWith("/api/history/")) {
      return handleHistoryDelete(request, env, url.pathname.slice("/api/history/".length));
    }
    if (url.pathname === "/api/parent/link-child") {
      return handleParentLinkChild(request, env);
    }
    if (url.pathname === "/api/parent/children") {
      return handleParentChildren(request, env);
    }
    if (url.pathname.startsWith("/api/parent/child-live/")) {
      return handleParentChildLive(request, env, decodeURIComponent(url.pathname.slice("/api/parent/child-live/".length)));
    }
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      return handleAdminUsersList(request, env);
    }
    if (url.pathname === "/api/admin/users" && request.method === "POST") {
      return handleAdminUsersCreate(request, env);
    }
    if (url.pathname.startsWith("/api/admin/users/")) {
      const idStr = url.pathname.slice("/api/admin/users/".length);
      if (request.method === "PATCH") return handleAdminUsersUpdate(request, env, idStr);
      if (request.method === "DELETE") return handleAdminUsersDelete(request, env, idStr);
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
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

    // 儀表板金鑰：老師不登入也要能看全班進度，但不能只憑shareId——shareId跟學生作答連結是同一組，
    // 學生自己改網址就會看到全班。所以另外發一把只有出題者拿得到的key，存成獨立KV(不放進share:的payload，
    // 免得/api/share/:id這個公開端點把它一起吐給學生)
    const dashKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.COOLDOWN_KV.put("dashkey:" + id, dashKey, { expirationTtl: SHARE_TTL_SECONDS });

    return new Response(JSON.stringify({ id, dashKey }), {
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
    // 監考式即時監看用：每題目前實際選的選項/填的文字(不只是「是否已答」的數字)，
    // 只放進完整value(單人get()時才回傳)，不放進metadata(老師總覽list()用，維持輕量避免超過1KB上限)
    const answers = Array.isArray(body.answers)
      ? body.answers.slice(0, 200).map((a) => ({
          i: Number(a && a.i) || 0,
          selected: String((a && a.selected) || "").slice(0, 500),
        }))
      : [];

    const payload = JSON.stringify({ shareId, studentId, studentInfo, answered, total, answers, updatedAt });

    await env.COOLDOWN_KV.put(budgetKey, String(budgetUsed + 1), { expirationTtl: LIVE_BUDGET_TTL_SECONDS });
    await env.COOLDOWN_KV.put("live:" + shareId + ":" + studentId, payload, {
      expirationTtl: LIVE_PROGRESS_TTL_SECONDS,
      metadata: { ...studentInfo, answered, total, updatedAt },
    });

    // 若學生剛好有登入帳號(非必要,登入非強制)，額外記一筆「目前正在寫哪一份」的指標，
    // 讓已連結的家長帳號能直接透過孩子的username找到現在該看哪個shareId+studentId，
    // 不用另外拿到分享連結才能監看
    const studentUsername = String(body.studentUsername || "").trim();
    if (studentUsername) {
      await env.COOLDOWN_KV.put(
        "student-active:" + studentUsername,
        JSON.stringify({ shareId, studentId, updatedAt }),
        { expirationTtl: LIVE_PROGRESS_TTL_SECONDS }
      );
    }

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
// 測驗代碼：課堂上報一組6位數字比貼網址快得多(學生手機打6個數字就進得去)。
// 代碼只是shareId的短別名，存活時間跟分享題目一樣(30天)。
// 產生代碼需要登入(跟分享連結同一個門檻)，查詢不需要——學生本來就是要靠它進來。
async function handleCodeCreate(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const session = await verifySession(request, env);
  if (!session) return json({ error: { message: "產生測驗代碼需要登入" } }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: { message: "格式錯誤" } }, 400);
  }
  const shareId = String(body.shareId || "").trim();
  if (!shareId) return json({ error: { message: "缺少shareId" } }, 400);

  const exists = await env.COOLDOWN_KV.get("share:" + shareId);
  if (!exists) return json({ error: { message: "找不到這份測驗，請重新分享一次" } }, 404);

  // 同一份測驗重複產生就沿用原本的代碼，老師才不會每按一次就換一組、報錯數字
  const cached = await env.COOLDOWN_KV.get("share-code:" + shareId);
  if (cached) return json({ code: cached });

  // 六位數字，開頭不為0(避免使用者漏打前面的0)。碰撞就重抽，最多5次
  let code = "";
  for (let i = 0; i < 5; i++) {
    const candidate = String(Math.floor(100000 + Math.random() * 900000));
    const taken = await env.COOLDOWN_KV.get("code:" + candidate);
    if (!taken) { code = candidate; break; }
  }
  if (!code) return json({ error: { message: "代碼產生失敗，請再試一次" } }, 500);

  await env.COOLDOWN_KV.put("code:" + code, shareId, { expirationTtl: SHARE_TTL_SECONDS });
  await env.COOLDOWN_KV.put("share-code:" + shareId, code, { expirationTtl: SHARE_TTL_SECONDS });
  return json({ code });
}

async function handleCodeLookup(request, env, code) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const clean = String(code || "").replace(/\D/g, "");
  if (clean.length !== 6) return json({ error: { message: "測驗代碼是6位數字" } }, 400);

  const shareId = await env.COOLDOWN_KV.get("code:" + clean);
  if (!shareId) return json({ error: { message: "查無此測驗代碼，可能打錯或已過期(30天)" } }, 404);
  return json({ shareId });
}

// 儀表板金鑰驗證：接受 ?k=xxx 或 X-Dash-Key header(前端輪詢時用header，複製給人的連結用查詢字串)
async function hasValidDashKey(request, env, shareId) {
  const url = new URL(request.url);
  const given = request.headers.get("X-Dash-Key") || url.searchParams.get("k") || "";
  if (!given || !shareId) return false;
  const expected = await env.COOLDOWN_KV.get("dashkey:" + shareId);
  return !!expected && given === expected;
}

// 停止/恢復監看：只有老師、家長、超級管理員可以，學生不行——被監考的人不該有權關掉監考。
// 學生手上雖然握有自己的shareId+studentId，但那組ID不構成撤銷權，這裡一律要求下列憑證之一：
// - 儀表板金鑰(老師，免登入)
// - 超級管理員的session token
// - 家長的session token，且該studentId確實屬於自己已連結的孩子
async function handleLiveRevoke(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: { message: "Method Not Allowed" } }, 405);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: { message: "格式錯誤" } }, 400);
  }
  const shareId = String(body.shareId || "").trim();
  const studentId = String(body.studentId || "").trim();
  const revoked = body.revoked !== false;
  if (!shareId) return json({ error: { message: "缺少shareId" } }, 400);

  const hasKey = await hasValidDashKey(request, env, shareId);
  const session = hasKey ? null : await verifySession(request, env);
  const isTeacher = !!session && (session.role === "teacher" || session.role === "superadmin");

  if (studentId) {
    let allowed = hasKey || isTeacher;
    if (!allowed && session && session.role === "parent") {
      allowed = await parentOwnsLiveStudent(env, session.uid, shareId, studentId);
    }
    if (!allowed) {
      return json({ error: { message: "只有老師、已連結的家長或管理員可以停止監看" } }, 403);
    }
    const key = "revoke:live:" + shareId + ":" + studentId;
    if (revoked) await env.COOLDOWN_KV.put(key, "1", { expirationTtl: LIVE_PROGRESS_TTL_SECONDS });
    else await env.COOLDOWN_KV.delete(key);
    return json({ ok: true, revoked });
  }

  if (!hasKey && !isTeacher) {
    return json({ error: { message: "需要儀表板連結或老師帳號才能停止全班監看" } }, 403);
  }
  const key = "revoke:dash:" + shareId;
  if (revoked) await env.COOLDOWN_KV.put(key, "1", { expirationTtl: SHARE_TTL_SECONDS });
  else await env.COOLDOWN_KV.delete(key);
  return json({ ok: true, revoked });
}

// 這位家長是不是這筆即時進度的家長？即時進度的studentId是作答分頁的隨機ID、不是帳號，
// 所以透過孩子登入時寫下的student-active:<username>指標反查：只要指標指到同一組shareId+studentId，
// 而且該username確實是這位家長已連結的孩子，就算數
async function parentOwnsLiveStudent(env, parentId, shareId, studentId) {
  const rows = await env.DB.prepare(
    "SELECT u.username FROM parent_child_links l JOIN users u ON u.id = l.student_id WHERE l.parent_id = ?"
  ).bind(parentId).all();
  for (const r of rows.results || []) {
    const raw = await env.COOLDOWN_KV.get("student-active:" + r.username);
    if (!raw) continue;
    try {
      const a = JSON.parse(raw);
      if (a.shareId === shareId && a.studentId === studentId) return true;
    } catch (e) {}
  }
  return false;
}

async function handleLiveProgressList(request, env, shareId) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!shareId) {
    return new Response(JSON.stringify({ error: { message: "缺少shareId" } }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // 三種身分都可以看全班進度：
  // (1) 儀表板金鑰(免登入，出題當下拿到的那條連結) (2) 登入的老師/超級管理員 (3) 管理者密碼(舊有用法)
  const hasKey = await hasValidDashKey(request, env, shareId);
  const adminPass = request.headers.get("X-Admin-Pass") || "";
  const expectedAdminPass = env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  const isAdminPass = adminPass !== "" && adminPass === expectedAdminPass;
  let isTeacher = false;
  if (!hasKey && !isAdminPass) {
    const session = await verifySession(request, env);
    isTeacher = !!session && (session.role === "teacher" || session.role === "superadmin");
  }
  if (!hasKey && !isAdminPass && !isTeacher) {
    return new Response(JSON.stringify({ error: { message: "需要儀表板連結、老師帳號登入或管理者密碼" } }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // 老師按過「停止監看」就讓這條金鑰連結失效(帳號/密碼身分不受影響，因為那是自己的帳號)
  if (hasKey && !isAdminPass && !isTeacher) {
    const revoked = await env.COOLDOWN_KV.get("revoke:dash:" + shareId);
    if (revoked) {
      return new Response(JSON.stringify({ error: { message: "這份測驗的監看已被停止" } }), {
        status: 403,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
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

  // 學生按過「停止監看」就讓發出去的家長連結失效；老師持儀表板金鑰仍看得到(監考需求不受學生控制)
  const revoked = await env.COOLDOWN_KV.get("revoke:live:" + shareId + ":" + studentId);
  if (revoked && !(await hasValidDashKey(request, env, shareId))) {
    return new Response(JSON.stringify({ error: { message: "學生已停止分享即時監看" } }), {
      status: 403,
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

// ==================== 帳號系統 (學生/家長/老師/超級管理員) ====================
// 密碼用PBKDF2雜湊(Workers runtime原生crypto.subtle支援,不需額外套件)，
// session token是HMAC-SHA256簽章的{uid,role,exp}，存在前端localStorage，
// 每次請求帶X-Session-Token header驗證(跟現有X-Admin-Pass同樣是header-based,不用cookie，
// 避免要重新設定CORS credentials)。帳號/班級/歷史資料存D1(binding DB)，關聯式查詢跟
// 50筆上限裁剪這種需要交易語意的操作，KV做不好。

function bytesToBase64(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hashPassword(password, existingSaltB64) {
  const enc = new TextEncoder();
  const salt = existingSaltB64 ? base64ToBytes(existingSaltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: bytesToBase64(new Uint8Array(bits)), salt: bytesToBase64(salt) };
}

async function verifyPassword(password, saltB64, expectedHashB64) {
  const { hash } = await hashPassword(password, saltB64);
  return hash === expectedHashB64;
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToBase64(new Uint8Array(sig));
}

async function signToken(payloadObj, secret) {
  const payload = bytesToBase64(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const sig = await hmacSign(payload, secret);
  return payload + "." + sig;
}

// 解出並驗證前端帶來的X-Session-Token，回傳{uid,role,exp}或null(沒登入/簽章不符/過期)
async function verifySession(request, env) {
  const token = request.headers.get("X-Session-Token") || "";
  if (!token) return null;
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = await hmacSign(payloadB64, env.SESSION_SECRET || "");
  if (sig !== expectedSig) return null;
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(base64ToBytes(payloadB64)));
  } catch (e) {
    return null;
  }
  if (!data || !data.exp || Date.now() > data.exp) return null;
  return data;
}

// 自由註冊：任何人都能選學生/家長/老師其中一種角色註冊(超級管理員不開放自助註冊，
// 避免任何人自封管理員；superadmin帳號由Steve用wrangler d1 execute手動塞一筆)。
// 老師註冊時一併建立自己的班級(班級名稱如「六年1班」全站唯一，同時當作學生加入用的班級代碼，
// 不是給老師看的內部數字ID)；學生註冊時可選填班級代碼加入，沒填之後也能在帳號頁面補填。
async function handleAuthRegister(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: { message: "Method Not Allowed" } }, 405);

  try {
    const body = await request.json();
    const username = String(body.username || "").trim().slice(0, 50);
    const password = String(body.password || "");
    const role = String(body.role || "");
    const displayName = String(body.displayName || username).slice(0, 50);

    if (!username || !password || !["student", "parent", "teacher"].includes(role)) {
      return json({ error: { message: "請填寫帳號、密碼，並選擇學生/家長/老師其中一種角色" } }, 400);
    }
    if (password.length < 6) {
      return json({ error: { message: "密碼至少需要6碼" } }, 400);
    }

    const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
    if (existing) {
      return json({ error: { message: "這個帳號名稱已經被使用" } }, 400);
    }

    let classId = null;
    let className = "";
    if (role === "teacher") {
      className = String(body.className || "").trim().slice(0, 50);
      if (!className) return json({ error: { message: "老師註冊請填寫班級名稱" } }, 400);
      // 班級名稱本身就是學生加入班級用的代碼(如「六年1班」)，必須全站唯一才能拿來查找
      const existingClass = await env.DB.prepare("SELECT id FROM classes WHERE name = ?").bind(className).first();
      if (existingClass) return json({ error: { message: "這個班級名稱已經被使用，請換一個更完整的名稱（例如加上學校或年度）" } }, 400);
    } else if (role === "student" && body.classCode) {
      // 班級代碼(選填)：學生可以先註冊，之後再透過 /api/auth/join-class 補填
      const classCode = String(body.classCode || "").trim().slice(0, 50);
      const cls = await env.DB.prepare("SELECT id FROM classes WHERE name = ?").bind(classCode).first();
      if (!cls) return json({ error: { message: "找不到這個班級代碼，請跟老師確認名稱是否正確" } }, 400);
      classId = cls.id;
    }

    const { hash, salt } = await hashPassword(password);
    const now = Date.now();

    const insertUser = await env.DB.prepare(
      "INSERT INTO users (username, password_hash, salt, role, display_name, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(username, hash, salt, role, displayName, classId, now).run();
    const userId = insertUser.meta.last_row_id;

    if (role === "teacher") {
      const clsInsert = await env.DB.prepare(
        "INSERT INTO classes (name, teacher_id, created_at) VALUES (?, ?, ?)"
      ).bind(className, userId, now).run();
      classId = clsInsert.meta.last_row_id;
      await env.DB.prepare("UPDATE users SET class_id = ? WHERE id = ?").bind(classId, userId).run();
    }

    const token = await signToken({ uid: userId, role, exp: now + SESSION_TTL_SECONDS * 1000 }, env.SESSION_SECRET || "");
    return json({ token, user: { id: userId, username, role, displayName, classId, className: role === "teacher" ? className : null } });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

async function handleAuthLogin(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: { message: "Method Not Allowed" } }, 405);

  try {
    const body = await request.json();
    const username = String(body.username || "").trim().slice(0, 50);
    const password = String(body.password || "");

    const user = await env.DB.prepare(
      "SELECT id, username, password_hash, salt, role, display_name, class_id FROM users WHERE username = ?"
    ).bind(username).first();

    if (!user || !(await verifyPassword(password, user.salt, user.password_hash))) {
      return json({ error: { message: "帳號或密碼錯誤" } }, 401);
    }

    const now = Date.now();
    const token = await signToken({ uid: user.id, role: user.role, exp: now + SESSION_TTL_SECONDS * 1000 }, env.SESSION_SECRET || "");
    let className = null;
    if (user.class_id) {
      const cls = await env.DB.prepare("SELECT name FROM classes WHERE id = ?").bind(user.class_id).first();
      className = cls ? cls.name : null;
    }
    return json({
      token,
      user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name, classId: user.class_id, className },
    });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

async function handleAuthMe(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const session = await verifySession(request, env);
  if (!session) return json({ error: { message: "未登入或登入已過期" } }, 401);

  const user = await env.DB.prepare(
    "SELECT id, username, role, display_name, class_id FROM users WHERE id = ?"
  ).bind(session.uid).first();
  if (!user) return json({ error: { message: "帳號不存在" } }, 401);

  let className = null;
  if (user.class_id) {
    const cls = await env.DB.prepare("SELECT name FROM classes WHERE id = ?").bind(user.class_id).first();
    className = cls ? cls.name : null;
  }

  return json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      classId: user.class_id,
      className,
    },
  });
}

// 學生註冊時沒填班級代碼，之後想補填/更換班級用（例如轉班、註冊時還沒問到老師）
async function handleAuthJoinClass(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: { message: "Method Not Allowed" } }, 405);

  const session = await verifySession(request, env);
  if (!session) return json({ error: { message: "未登入或登入已過期" } }, 401);
  if (session.role !== "student") return json({ error: { message: "只有學生帳號可以加入班級" } }, 403);

  try {
    const body = await request.json();
    const classCode = String(body.classCode || "").trim().slice(0, 50);
    if (!classCode) return json({ error: { message: "請輸入班級代碼" } }, 400);
    const cls = await env.DB.prepare("SELECT id, name FROM classes WHERE name = ?").bind(classCode).first();
    if (!cls) return json({ error: { message: "找不到這個班級代碼，請跟老師確認名稱是否正確" } }, 400);

    await env.DB.prepare("UPDATE users SET class_id = ? WHERE id = ?").bind(cls.id, session.uid).run();
    return json({ classId: cls.id, className: cls.name });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

// ==================== 班級出題歷史 (老師登入後專用，每班上限50份) ====================

async function handleHistoryCreate(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: { message: "Method Not Allowed" } }, 405);

  const session = await verifySession(request, env);
  if (!session || session.role !== "teacher") {
    return json({ error: { message: "只有登入的老師可以存班級歷史" } }, 401);
  }

  try {
    const body = await request.json();
    const title = String(body.title || "測驗").slice(0, 200);
    const items = body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return json({ error: { message: "沒有題目內容可以存" } }, 400);
    }

    const user = await env.DB.prepare("SELECT class_id FROM users WHERE id = ?").bind(session.uid).first();
    if (!user || !user.class_id) {
      return json({ error: { message: "找不到你的班級" } }, 400);
    }
    const classId = user.class_id;
    const itemsJson = JSON.stringify(items);
    const now = Date.now();

    await env.DB.prepare(
      "INSERT INTO quiz_history (class_id, title, items_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(classId, title, itemsJson, session.uid, now).run();

    // 超過50筆自動刪最舊的,保持每班上限50份
    const countRow = await env.DB.prepare("SELECT COUNT(*) as c FROM quiz_history WHERE class_id = ?").bind(classId).first();
    if (countRow.c > HISTORY_MAX_PER_CLASS) {
      const toDelete = countRow.c - HISTORY_MAX_PER_CLASS;
      const oldest = await env.DB.prepare(
        "SELECT id FROM quiz_history WHERE class_id = ? ORDER BY created_at ASC LIMIT ?"
      ).bind(classId, toDelete).all();
      for (const row of oldest.results) {
        await env.DB.prepare("DELETE FROM quiz_history WHERE id = ?").bind(row.id).run();
      }
    }

    return json({ ok: true });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

async function handleHistoryList(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const session = await verifySession(request, env);
  if (!session || session.role !== "teacher") {
    return json({ error: { message: "只有登入的老師可以查看班級歷史" } }, 401);
  }

  const user = await env.DB.prepare("SELECT class_id FROM users WHERE id = ?").bind(session.uid).first();
  if (!user || !user.class_id) return json({ history: [] });

  const rows = await env.DB.prepare(
    "SELECT id, title, items_json, created_at FROM quiz_history WHERE class_id = ? ORDER BY created_at DESC"
  ).bind(user.class_id).all();

  const history = rows.results.map((r) => ({
    id: r.id,
    title: r.title,
    items: JSON.parse(r.items_json),
    createdAt: r.created_at,
  }));

  return json({ history });
}

async function handleHistoryDelete(request, env, idStr) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "DELETE") return json({ error: { message: "Method Not Allowed" } }, 405);

  const session = await verifySession(request, env);
  if (!session || session.role !== "teacher") {
    return json({ error: { message: "只有登入的老師可以刪除班級歷史" } }, 401);
  }

  const id = Number(idStr);
  const user = await env.DB.prepare("SELECT class_id FROM users WHERE id = ?").bind(session.uid).first();
  const row = await env.DB.prepare("SELECT class_id FROM quiz_history WHERE id = ?").bind(id).first();
  if (!row || !user || row.class_id !== user.class_id) {
    return json({ error: { message: "找不到這筆歷史記錄，或不屬於你的班級" } }, 404);
  }

  await env.DB.prepare("DELETE FROM quiz_history WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ==================== 家長連結孩子帳號 ====================
// 家長輸入孩子的username即可建立連結(不需孩子核准，家庭情境從簡)，
// 之後可以在即時監看頁面選擇要看哪個孩子的作答狀況。

async function handleParentLinkChild(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: { message: "Method Not Allowed" } }, 405);

  const session = await verifySession(request, env);
  if (!session || session.role !== "parent") {
    return json({ error: { message: "只有登入的家長可以連結孩子帳號" } }, 401);
  }

  try {
    const body = await request.json();
    const studentUsername = String(body.studentUsername || "").trim().slice(0, 50);
    if (!studentUsername) return json({ error: { message: "請輸入孩子的帳號名稱" } }, 400);

    const student = await env.DB.prepare("SELECT id, role FROM users WHERE username = ?").bind(studentUsername).first();
    if (!student || student.role !== "student") {
      return json({ error: { message: "找不到這個學生帳號" } }, 404);
    }

    await env.DB.prepare(
      "INSERT OR IGNORE INTO parent_child_links (parent_id, student_id) VALUES (?, ?)"
    ).bind(session.uid, student.id).run();

    return json({ ok: true });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

async function handleParentChildren(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const session = await verifySession(request, env);
  if (!session || session.role !== "parent") {
    return json({ error: { message: "只有登入的家長可以查看" } }, 401);
  }

  const rows = await env.DB.prepare(
    "SELECT u.id, u.username, u.display_name FROM parent_child_links l JOIN users u ON u.id = l.student_id WHERE l.parent_id = ?"
  ).bind(session.uid).all();

  return json({ children: rows.results.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name })) });
}

// 家長監考式即時監看：透過已連結孩子的username找到孩子「目前正在寫哪一份」(student-active:指標，
// 由pushLiveProgress()在學生有登入時順便寫入)，再直接讀那份的即時進度(含每題實際作答內容)回傳，
// 格式跟handleLiveProgressGet一樣，前端可以共用同一套渲染函式。
async function handleParentChildLive(request, env, studentUsername) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const session = await verifySession(request, env);
  if (!session || session.role !== "parent") {
    return json({ error: { message: "只有登入的家長可以查看" } }, 401);
  }
  if (!studentUsername) {
    return json({ error: { message: "缺少學生帳號" } }, 400);
  }

  const link = await env.DB.prepare(
    "SELECT 1 FROM parent_child_links l JOIN users u ON u.id = l.student_id WHERE l.parent_id = ? AND u.username = ?"
  ).bind(session.uid, studentUsername).first();
  if (!link) {
    return json({ error: { message: "尚未連結這個學生帳號" } }, 403);
  }

  const activeRaw = await env.COOLDOWN_KV.get("student-active:" + studentUsername);
  if (!activeRaw) {
    return json({ error: { message: "孩子目前沒有正在作答中的測驗" } }, 404);
  }
  const active = JSON.parse(activeRaw);

  const raw = await env.COOLDOWN_KV.get("live:" + active.shareId + ":" + active.studentId);
  if (!raw) {
    return json({ error: { message: "找不到即時進度，可能已過期(8小時)" } }, 404);
  }

  return new Response(raw, { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// ==================== 超級管理員後台 ====================
// 帳號列表/搜尋/手動建立/改角色/重設密碼/刪除。superadmin帳號不開放自助註冊(見handleAuthRegister的白名單)，
// 只能由既有superadmin帳號用「手動建立帳號」功能生出下一個，或Steve自己用wrangler d1 execute塞第一筆。

async function requireSuperadmin(request, env) {
  const session = await verifySession(request, env);
  if (!session || session.role !== "superadmin") return null;
  return session;
}

async function handleAdminUsersList(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const session = await requireSuperadmin(request, env);
  if (!session) return json({ error: { message: "需要管理員登入" } }, 401);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  let rows;
  if (q) {
    const like = "%" + q + "%";
    rows = await env.DB.prepare(
      "SELECT u.id, u.username, u.role, u.display_name, u.class_id, u.created_at, c.name as class_name " +
      "FROM users u LEFT JOIN classes c ON c.id = u.class_id " +
      "WHERE u.username LIKE ? OR u.display_name LIKE ? ORDER BY u.created_at DESC"
    ).bind(like, like).all();
  } else {
    rows = await env.DB.prepare(
      "SELECT u.id, u.username, u.role, u.display_name, u.class_id, u.created_at, c.name as class_name " +
      "FROM users u LEFT JOIN classes c ON c.id = u.class_id ORDER BY u.created_at DESC"
    ).all();
  }

  const users = rows.results.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    displayName: r.display_name,
    classId: r.class_id,
    className: r.class_name,
    createdAt: r.created_at,
  }));

  return json({ users });
}

// 管理員專用建立管道：跟自助註冊(handleAuthRegister)不同，這裡role可以是superadmin，
// 也不限制一人一種角色的自然限制(管理員可以幫任何人開任何角色的帳號)。
async function handleAdminUsersCreate(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const session = await requireSuperadmin(request, env);
  if (!session) return json({ error: { message: "需要管理員登入" } }, 401);

  try {
    const body = await request.json();
    const username = String(body.username || "").trim().slice(0, 50);
    const password = String(body.password || "");
    const role = String(body.role || "");
    const displayName = String(body.displayName || username).slice(0, 50);

    if (!username || !password || !["student", "parent", "teacher", "superadmin"].includes(role)) {
      return json({ error: { message: "請填寫帳號、密碼，並選擇正確的角色" } }, 400);
    }
    if (password.length < 6) {
      return json({ error: { message: "密碼至少需要6碼" } }, 400);
    }

    const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
    if (existing) return json({ error: { message: "這個帳號名稱已經被使用" } }, 400);

    let classId = null;
    let className = "";
    if (role === "teacher") {
      className = String(body.className || "").trim().slice(0, 50);
      if (!className) return json({ error: { message: "老師帳號請填寫班級名稱" } }, 400);
      const existingClass = await env.DB.prepare("SELECT id FROM classes WHERE name = ?").bind(className).first();
      if (existingClass) return json({ error: { message: "這個班級名稱已經被使用，請換一個更完整的名稱" } }, 400);
    }

    const { hash, salt } = await hashPassword(password);
    const now = Date.now();

    const insertUser = await env.DB.prepare(
      "INSERT INTO users (username, password_hash, salt, role, display_name, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(username, hash, salt, role, displayName, classId, now).run();
    const userId = insertUser.meta.last_row_id;

    if (role === "teacher") {
      const clsInsert = await env.DB.prepare(
        "INSERT INTO classes (name, teacher_id, created_at) VALUES (?, ?, ?)"
      ).bind(className, userId, now).run();
      classId = clsInsert.meta.last_row_id;
      await env.DB.prepare("UPDATE users SET class_id = ? WHERE id = ?").bind(classId, userId).run();
    }

    return json({ ok: true, id: userId });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

async function handleAdminUsersUpdate(request, env, idStr) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const session = await requireSuperadmin(request, env);
  if (!session) return json({ error: { message: "需要管理員登入" } }, 401);

  const id = Number(idStr);
  const target = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
  if (!target) return json({ error: { message: "找不到這個帳號" } }, 404);

  try {
    const body = await request.json();
    const updates = [];
    const values = [];

    if (typeof body.displayName === "string" && body.displayName.trim()) {
      updates.push("display_name = ?");
      values.push(body.displayName.trim().slice(0, 50));
    }
    if (typeof body.role === "string" && ["student", "parent", "teacher", "superadmin"].includes(body.role)) {
      updates.push("role = ?");
      values.push(body.role);
    }
    if (typeof body.newPassword === "string" && body.newPassword) {
      if (body.newPassword.length < 6) return json({ error: { message: "新密碼至少需要6碼" } }, 400);
      const { hash, salt } = await hashPassword(body.newPassword);
      updates.push("password_hash = ?", "salt = ?");
      values.push(hash, salt);
    }

    if (updates.length === 0) return json({ error: { message: "沒有要更新的欄位" } }, 400);

    values.push(id);
    await env.DB.prepare("UPDATE users SET " + updates.join(", ") + " WHERE id = ?").bind(...values).run();

    return json({ ok: true });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

// 刪除帳號會連帶清理關聯資料：老師連班級+該班歷史記錄一起刪(該班學生的class_id設回NULL)，
// 家長/學生則清掉parent_child_links裡對應的連結記錄，避免留下指向已刪除帳號的孤兒資料。
async function handleAdminUsersDelete(request, env, idStr) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const session = await requireSuperadmin(request, env);
  if (!session) return json({ error: { message: "需要管理員登入" } }, 401);

  const id = Number(idStr);
  if (id === session.uid) {
    return json({ error: { message: "不能刪除自己目前登入的帳號" } }, 400);
  }

  const target = await env.DB.prepare("SELECT id, role, class_id FROM users WHERE id = ?").bind(id).first();
  if (!target) return json({ error: { message: "找不到這個帳號" } }, 404);

  try {
    if (target.role === "teacher") {
      const cls = await env.DB.prepare("SELECT id FROM classes WHERE teacher_id = ?").bind(id).first();
      if (cls) {
        await env.DB.prepare("DELETE FROM quiz_history WHERE class_id = ?").bind(cls.id).run();
        await env.DB.prepare("UPDATE users SET class_id = NULL WHERE class_id = ?").bind(cls.id).run();
        await env.DB.prepare("DELETE FROM classes WHERE id = ?").bind(cls.id).run();
      }
    } else if (target.role === "parent") {
      await env.DB.prepare("DELETE FROM parent_child_links WHERE parent_id = ?").bind(id).run();
    } else if (target.role === "student") {
      await env.DB.prepare("DELETE FROM parent_child_links WHERE student_id = ?").bind(id).run();
    }

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}
