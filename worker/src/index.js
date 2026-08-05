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
// 管理者密碼只從 secret 讀，原始碼裡不留預設值——這個 repo 是 public，
// 寫死的預設密碼等於公開，任何人都能拿去略過冷卻、查 Key 池狀態。
// 沒設 ADMIN_PASSWORD secret 時，管理者密碼一律視為不成立（功能停用，不是放行）。
function adminPassMatches(request, env) {
  const expected = String(env.ADMIN_PASSWORD || "");
  if (expected === "") return false;
  const got = request.headers.get("X-Admin-Pass") || "";
  return got !== "" && got === expected;
}
const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
const SHARE_TTL_SECONDS = 60 * 60 * 24 * 30; // 分享連結30天後過期
// 單份分享內容上限。/api/share 不需登入(訪客也能分享)，所以這是唯一擋濫用的關卡。
// 50 題的題目 JSON 實測約 30KB，120KB 已經很寬鬆；原本設 500KB 是沒必要的攻擊面
// （KV 免費方案每日只有 1000 次寫入，被灌大包資料很快就把全站額度吃光）
const SHARE_MAX_BYTES = 120 * 1024;
const RESULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 作答結果連結30天後過期
const RESULT_MAX_BYTES = 300 * 1024; // 單份結果內容上限300KB
const LIVE_PROGRESS_TTL_SECONDS = 60 * 60 * 8; // 即時進度8小時後自動過期(教室情境用不到這麼久)
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 登入session 30天後需要重新登入
const HISTORY_MAX_PER_CLASS = 50; // 每個班級最多存50份出題歷史,超過自動刪最舊的

// 原卷直上：保留一學年，單卷 10 頁／5MB（Steve 2026-08-05 定案）
const PAPER_TTL_SECONDS = 60 * 60 * 24 * 365;
const PAPER_MAX_PAGES = 10;
const PAPER_MAX_BYTES = 5 * 1024 * 1024;
// 學生手寫作答的截圖：單一作答區 400KB、整份 3MB。手寫是線條，PNG 壓完通常只有幾十 KB，
// 這個上限是擋「有人把整張高解析照片塞進來」，不是給正常使用者踩的
const HAND_MAX_BYTES = 400 * 1024;
const SUBMIT_MAX_BYTES = 3 * 1024 * 1024;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
    // 原卷直上（/api/paper/...）
    if (url.pathname === "/api/paper" && request.method === "POST") {
      return handlePaperCreate(request, env);
    }
    if (url.pathname.startsWith("/api/paper/")) {
      const seg = url.pathname.slice("/api/paper/".length).split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
      const id = seg[0] || "";
      if (seg.length === 1) {
        if (request.method === "GET") return handlePaperGet(request, env, id);
        if (request.method === "PATCH") return handlePaperUpdate(request, env, id);
        if (request.method === "DELETE") return handlePaperDelete(request, env, id);
      }
      if (seg.length === 3 && seg[1] === "page") {
        if (request.method === "PUT") return handlePaperPageUpload(request, env, id, seg[2]);
        if (request.method === "GET") return handlePaperPageGet(request, env, id, seg[2]);
      }
      if (seg.length === 2 && seg[1] === "detect" && request.method === "POST") {
        return handlePaperDetect(request, env, id);
      }
      if (seg.length === 2 && seg[1] === "submit" && request.method === "POST") {
        return handlePaperSubmit(request, env, id);
      }
      if (seg.length === 2 && seg[1] === "submissions" && request.method === "GET") {
        return handlePaperSubmissionList(request, env, id);
      }
      if (seg.length === 3 && seg[1] === "submission") {
        if (request.method === "GET") return handlePaperSubmissionGet(request, env, id, seg[2]);
        if (request.method === "PATCH") return handlePaperSubmissionGrade(request, env, id, seg[2]);
      }
      if (seg.length === 4 && seg[1] === "submission" && seg[3] === "ai-grade" && request.method === "POST") {
        return handlePaperAiGrade(request, env, id, seg[2]);
      }
      if (seg.length === 4 && seg[1] === "hand" && request.method === "GET") {
        // /api/paper/:id/hand/:studentId/:regionId — 學生手寫作答的截圖
        return handlePaperHandGet(request, env, id, seg[2], seg[3]);
      }
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

// 即時進度：學生線上作答時把進度推上來，老師可以開儀表板看全班、家長可以看自己小孩。
// 存在 D1 的 live_progress 表（primary key = share_id + student_id，UPSERT 覆蓋）。
//
// 2026-07-29 從 KV 搬過來：KV 免費方案每日只有 1000 次寫入，而舊版一次上報要寫 2~3 個 key
// （進度本身、每日預算計數器、student-active 指標），舊的 400 次「請求數」上限實際等於
// 800~1200 次寫入，早就超過額度，保護形同虛設；而且計數器是 read-modify-write，
// 多人同時作答還會互相覆蓋。D1 免費每日 10 萬列寫入，一個班考一次試只用掉 0.6%。
// D1 沒有 TTL，改成寫入時順手刪掉逾期的列。
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

    const studentInfo = {
      grade: String((body.studentInfo && body.studentInfo.grade) || "").slice(0, 50),
      className: String((body.studentInfo && body.studentInfo.className) || "").slice(0, 50),
      seat: String((body.studentInfo && body.studentInfo.seat) || "").slice(0, 20),
      name: String((body.studentInfo && body.studentInfo.name) || "").slice(0, 50),
    };
    const answered = Number(body.answered) || 0;
    const total = Number(body.total) || 0;
    const updatedAt = Date.now();
    // 監考式即時監看用：每題目前實際選的選項/填的文字(不只是「是否已答」的數字)
    const answers = Array.isArray(body.answers)
      ? body.answers.slice(0, 200).map((a) => ({
          i: Number(a && a.i) || 0,
          selected: String((a && a.selected) || "").slice(0, 500),
        }))
      : [];

    // 學生若剛好有登入帳號(非強制)就記下來，讓已連結的家長能用孩子帳號反查
    // 「現在正在寫哪一份」，不必另外拿到分享連結
    const studentUsername = String(body.studentUsername || "").trim().slice(0, 100);

    await env.DB.prepare(
      `INSERT INTO live_progress
         (share_id, student_id, student_username, grade, class_name, seat, name, answered, total, answers, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(share_id, student_id) DO UPDATE SET
         student_username = excluded.student_username,
         grade = excluded.grade, class_name = excluded.class_name,
         seat = excluded.seat, name = excluded.name,
         answered = excluded.answered, total = excluded.total,
         answers = excluded.answers, updated_at = excluded.updated_at`
    )
      .bind(
        shareId, studentId, studentUsername,
        studentInfo.grade, studentInfo.className, studentInfo.seat, studentInfo.name,
        answered, total, JSON.stringify(answers), updatedAt
      )
      .run();

    // D1 沒有 TTL，順手清掉逾期的列。只在剛開始作答時做(answered <= 1)，
    // 避免每次上報都多跑一次 DELETE
    if (answered <= 1) {
      await env.DB.prepare("DELETE FROM live_progress WHERE updated_at < ?")
        .bind(updatedAt - LIVE_PROGRESS_TTL_SECONDS * 1000)
        .run();
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
// 所以靠學生上報時一起寫下的 student_username 反查：只要那筆進度的帳號確實是
// 這位家長已連結的孩子，就算數。（原本要逐一 KV get，現在一條 JOIN 就問完）
async function parentOwnsLiveStudent(env, parentId, shareId, studentId) {
  const row = await env.DB.prepare(
    `SELECT 1 FROM live_progress p
       JOIN users u ON u.username = p.student_username
       JOIN parent_child_links l ON l.student_id = u.id
      WHERE l.parent_id = ? AND p.share_id = ? AND p.student_id = ?
      LIMIT 1`
  ).bind(parentId, shareId, studentId).first();
  return !!row;
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
  const isAdminPass = adminPassMatches(request, env);
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

  // 總覽只取輕量欄位，不撈 answers（那是單人詳情視窗才要的）
  const rows = await env.DB.prepare(
    `SELECT student_id, grade, class_name, seat, name, answered, total, updated_at
       FROM live_progress WHERE share_id = ? AND updated_at >= ?
      ORDER BY updated_at DESC`
  )
    .bind(shareId, Date.now() - LIVE_PROGRESS_TTL_SECONDS * 1000)
    .all();
  const students = (rows.results || []).map((r) => ({
    studentId: r.student_id,
    grade: r.grade,
    className: r.class_name,
    seat: r.seat,
    name: r.name,
    answered: r.answered,
    total: r.total,
    updatedAt: r.updated_at,
  }));

  return new Response(JSON.stringify({ students }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// 讀一筆即時進度，並組回前端原本就在吃的那個 JSON 形狀（studentInfo 巢狀、answers 陣列）。
// 逾期(8小時)的列視同不存在，等下一次寫入時的 DELETE 順手清掉。
async function getLiveProgressRow(env, shareId, studentId) {
  const r = await env.DB.prepare(
    `SELECT * FROM live_progress WHERE share_id = ? AND student_id = ? AND updated_at >= ?`
  )
    .bind(shareId, studentId, Date.now() - LIVE_PROGRESS_TTL_SECONDS * 1000)
    .first();
  if (!r) return null;
  let answers = [];
  try {
    answers = JSON.parse(r.answers || "[]");
  } catch (e) {
    answers = [];
  }
  return {
    shareId: r.share_id,
    studentId: r.student_id,
    studentInfo: { grade: r.grade, className: r.class_name, seat: r.seat, name: r.name },
    answered: r.answered,
    total: r.total,
    answers,
    updatedAt: r.updated_at,
  };
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

  const live = await getLiveProgressRow(env, shareId, studentId);
  if (!live) {
    return new Response(JSON.stringify({ error: { message: "找不到這位學生的即時進度，可能還沒開始作答或已過期(8小時)" } }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(live), {
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

  if (!adminPassMatches(request, env)) {
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
    const batchIndex = parseInt(request.headers.get("X-Batch-Index") || "0", 10);
    const isAdmin = adminPassMatches(request, env);
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
    const baseConfig = payload.generationConfig || {
      responseMimeType: "application/json",
      // 原本8192太容易被題數多/計算解析題較長的輸出截斷,導致JSON陣列沒收尾解析失敗
      // (Steve回報「AI回傳的內容無法解析成題目格式」常出現),提高上限降低截斷機率
      maxOutputTokens: 32768,
      // gemini-3.x 是思考模型,思考用掉的 token 也算在 maxOutputTokens 裡。
      // 實測一批 10 題國語文:預設思考 4804 tokens、輸出才 1699,思考是輸出的 2.8 倍;
      // 改成 low 之後思考降到 1571(-68%),截斷風險與延遲都明顯下降,題目品質沒有差別。
      thinkingConfig: { thinkingLevel: "low" },
    };
    const requestBody = JSON.stringify({ contents: payload.contents, generationConfig: baseConfig });
    // 萬一某個模型不吃 thinkingConfig(例如舊模型),同一組 Key 拿掉它再試一次,不要整批失敗
    const noThinkConfig = { ...baseConfig };
    delete noThinkConfig.thinkingConfig;
    const requestBodyNoThink = JSON.stringify({ contents: payload.contents, generationConfig: noThinkConfig });

    // 回應有 200 但拿不到文字的情況(思考吃光額度被 MAX_TOKENS 截斷、被安全機制擋掉…),
    // 前端只會看到「AI回傳的內容無法解析成題目格式」。這裡先判掉,讓它換下一組 Key／模型重試。
    const extractText = (d) => {
      const parts = d?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return "";
      return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    };

    const callGemini = async (url, body) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return await res.json();
    };

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
          let resData = await callGemini(googleUrl, requestBody);
          if (resData.error && /thinking|thinkingConfig|thinkingLevel/i.test(resData.error.message || "")) {
            resData = await callGemini(googleUrl, requestBodyNoThink);
          }
          if (resData.error) {
            lastError = resData.error;
            continue;
          }
          if (!extractText(resData)) {
            // 200 但沒有可用文字：記下 finishReason 方便日後追，然後換下一組 Key／模型
            const reason = resData?.candidates?.[0]?.finishReason || "UNKNOWN";
            lastError = { message: `模型 ${model} 回應沒有文字內容（finishReason=${reason}）` };
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

// 家長監考式即時監看：用已連結孩子的username直接撈出他最近一筆即時進度(含每題實際作答內容)，
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

  // 孩子最近在寫的那一份（8小時內），直接一條 SQL 問完
  const active = await env.DB.prepare(
    `SELECT share_id, student_id FROM live_progress
      WHERE student_username = ? AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT 1`
  ).bind(studentUsername, Date.now() - LIVE_PROGRESS_TTL_SECONDS * 1000).first();
  if (!active) {
    return json({ error: { message: "孩子目前沒有正在作答中的測驗" } }, 404);
  }

  const live = await getLiveProgressRow(env, active.share_id, active.student_id);
  if (!live) {
    return json({ error: { message: "找不到即時進度，可能已過期(8小時)" } }, 404);
  }

  return json(live);
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

// ==================== 原卷直上（Kami 式文件互動，AI 大腦用我們自己的） ====================
// 流程：老師上傳現成考卷影像 → Gemini 視覺自動抓每題作答區 → 老師拖拉微調 → 發分享連結
//      → 學生在原卷上作答（選擇題點選／填空打字／計算題手寫）→ 自動判選擇填空
//      → 老師批改介面按「AI 協助批改」讀手寫給建議，老師確認才算數。
//
// 權限模型沿用既有的 dashKey：建立卷子時發一把只有出題者拿得到的金鑰（KV `dashkey:<paperId>`），
// 卷子 ID 本身只夠拿來作答，不足以看答案、看全班成績、改分數。

// 影像本身不做身分驗證（跟現有分享連結同一套信任模型：拿得到連結就看得到卷子），
// 但答案、成績、批改一律要 dashKey 或老師帳號。
async function isPaperOwner(request, env, paperId) {
  if (await hasValidDashKey(request, env, paperId)) return true;
  const session = await verifySession(request, env);
  if (!session) return false;
  if (session.role === "superadmin") return true;
  if (session.role !== "teacher") return false;
  const row = await env.DB.prepare("SELECT owner_user_id FROM papers WHERE id = ?").bind(paperId).first();
  return !!row && Number(row.owner_user_id) === Number(session.uid);
}

async function getPaperRow(env, paperId) {
  if (!paperId) return null;
  const row = await env.DB.prepare("SELECT * FROM papers WHERE id = ?").bind(paperId).first();
  if (!row) return null;
  // 過期的卷子當作不存在（實體檔案由刪除流程清掉）
  if (Number(row.expires_at) < Date.now()) return null;
  return row;
}

function safeParse(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

// 呼叫 Gemini 並要求回 JSON。沿用 /api/generate 那套「隨機起始 Key → 換 Key → 換模型」的容錯，
// 差別是這裡吃的是多模態 parts（圖片 inlineData + 文字），而且回傳的是解析後的物件。
async function geminiJson(env, parts, maxOutputTokens) {
  const apiKeys = getApiKeys(env);
  if (apiKeys.length === 0) {
    throw new Error("伺服器未設定 GEMINI_API_KEYS");
  }
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: maxOutputTokens || 8192,
      // 3.x 的 thinking token 算在 maxOutputTokens 裡，不壓就會被截斷成沒有文字的 200
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  });

  const startIdx = Math.floor(Math.random() * apiKeys.length);
  let lastError = null;

  for (const model of GEMINI_MODELS) {
    for (let i = 0; i < apiKeys.length; i++) {
      const apiKey = apiKeys[(startIdx + i) % apiKeys.length];
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const data = await res.json();
        if (data.error) {
          lastError = data.error;
          continue;
        }
        const textParts = data && data.candidates && data.candidates[0] && data.candidates[0].content
          ? data.candidates[0].content.parts
          : null;
        const text = Array.isArray(textParts)
          ? textParts.map((p) => (typeof p.text === "string" ? p.text : "")).join("")
          : "";
        if (!text) {
          const reason = (data && data.candidates && data.candidates[0] && data.candidates[0].finishReason) || "UNKNOWN";
          lastError = { message: "模型 " + model + " 回應沒有文字內容（finishReason=" + reason + "）" };
          continue;
        }
        // 模型偶爾會用 markdown 圍欄包起來，先剝掉再解析
        const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        const parsed = safeParse(cleaned, null);
        if (parsed === null) {
          lastError = { message: "AI 回傳的內容不是合法 JSON" };
          continue;
        }
        return parsed;
      } catch (err) {
        lastError = { message: err.message };
      }
    }
  }
  throw new Error((lastError && lastError.message) || "所有 Key／模型皆呼叫失敗");
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  // 一次全部丟給 fromCharCode 會在大檔案時爆堆疊，分塊處理
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---- 建立卷子 ----
async function handlePaperCreate(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (!env.PAPERS_R2) return json({ error: { message: "伺服器尚未開通原卷儲存空間（R2）" } }, 503);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const title = String(body.title || "原卷測驗").slice(0, 200);
  const clientId = (request.headers.get("X-Client-Id") || "").trim();
  const session = await verifySession(request, env);
  const now = Date.now();
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const dashKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  try {
    await env.DB.prepare(
      "INSERT INTO papers (id, title, owner_client_id, owner_user_id, page_count, total_bytes," +
        " regions_json, answer_key_json, status, created_at, expires_at)" +
        " VALUES (?, ?, ?, ?, 0, 0, '[]', '{}', 'draft', ?, ?)"
    ).bind(id, title, clientId, session ? session.uid : null, now, now + PAPER_TTL_SECONDS * 1000).run();

    await env.COOLDOWN_KV.put("dashkey:" + id, dashKey, { expirationTtl: PAPER_TTL_SECONDS });
    return json({ id, dashKey, maxPages: PAPER_MAX_PAGES, maxBytes: PAPER_MAX_BYTES });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

// ---- 上傳一頁原卷影像（PUT，body 就是圖片本體）----
async function handlePaperPageUpload(request, env, paperId, pageStr) {
  if (!env.PAPERS_R2) return json({ error: { message: "伺服器尚未開通原卷儲存空間（R2）" } }, 503);
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子，可能已過期" } }, 404);
  if (!(await isPaperOwner(request, env, paperId))) {
    return json({ error: { message: "只有這份卷子的老師可以上傳頁面" } }, 403);
  }

  const page = parseInt(pageStr, 10);
  if (!Number.isInteger(page) || page < 1 || page > PAPER_MAX_PAGES) {
    return json({ error: { message: "頁碼必須是 1～" + PAPER_MAX_PAGES } }, 400);
  }

  const contentType = request.headers.get("Content-Type") || "image/jpeg";
  if (!/^image\//.test(contentType)) {
    return json({ error: { message: "只接受圖片格式（PDF 請在前端先轉成圖片再上傳）" } }, 400);
  }

  const buf = await request.arrayBuffer();
  const size = buf.byteLength;
  if (size === 0) return json({ error: { message: "沒有收到影像內容" } }, 400);

  // 同一頁重傳要換算差額，不能直接累加，否則老師重拍幾次就假性超額
  const key = "papers/" + paperId + "/p" + page;
  const existing = await env.PAPERS_R2.head(key);
  const prevSize = existing ? existing.size : 0;
  const newTotal = Number(paper.total_bytes) - prevSize + size;
  if (newTotal > PAPER_MAX_BYTES) {
    return json(
      { error: { message: "整份卷子上限 " + Math.round(PAPER_MAX_BYTES / 1024 / 1024) + "MB，這一頁放不下了（請降低掃描解析度或減少頁數）" } },
      413
    );
  }

  await env.PAPERS_R2.put(key, buf, { httpMetadata: { contentType } });
  const pageCount = Math.max(Number(paper.page_count), page);
  await env.DB.prepare("UPDATE papers SET page_count = ?, total_bytes = ? WHERE id = ?")
    .bind(pageCount, newTotal, paperId)
    .run();

  return json({ ok: true, page, pageCount, totalBytes: newTotal });
}

// ---- 取一頁原卷影像（學生要看，不做身分驗證，跟分享連結同一套信任模型）----
async function handlePaperPageGet(request, env, paperId, pageStr) {
  if (!env.PAPERS_R2) return json({ error: { message: "伺服器尚未開通原卷儲存空間（R2）" } }, 503);
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子，可能已過期" } }, 404);

  const page = parseInt(pageStr, 10);
  const obj = await env.PAPERS_R2.get("papers/" + paperId + "/p" + page);
  if (!obj) return json({ error: { message: "找不到這一頁" } }, 404);

  return new Response(obj.body, {
    headers: Object.assign({}, CORS_HEADERS, {
      "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg",
      // 卷子影像上傳後就不會變（重傳等於換內容、前端會帶 cache-buster），可以放心長快取
      "Cache-Control": "public, max-age=86400",
    }),
  });
}

// ---- AI 自動抓作答區 ----
// 回傳座標一律 0~1 正規化，前端不管螢幕多寬都能還原到影像上。
// 抓不準是常態：這裡只負責給老師一個起點，微調由前端的拖拉框負責。
async function handlePaperDetect(request, env, paperId) {
  if (!env.PAPERS_R2) return json({ error: { message: "伺服器尚未開通原卷儲存空間（R2）" } }, 503);
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子，可能已過期" } }, 404);
  if (!(await isPaperOwner(request, env, paperId))) {
    return json({ error: { message: "只有這份卷子的老師可以使用自動辨識" } }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const page = parseInt(body.page, 10) || 1;
  const obj = await env.PAPERS_R2.get("papers/" + paperId + "/p" + page);
  if (!obj) return json({ error: { message: "找不到這一頁，請先上傳" } }, 404);

  const buf = await obj.arrayBuffer();
  const prompt = [
    "你是台灣國中小考卷的版面分析助手。這是一張考卷影像。",
    "請找出「學生需要作答的位置」，每一題一個作答區，並用影像的相對比例回報座標。",
    "",
    "回傳格式（只回 JSON 陣列，不要任何說明文字）：",
    '[{"no":"1","type":"choice","x":0.12,"y":0.21,"w":0.30,"h":0.04,"label":"第1題","options":["A","B","C","D"],"score":5}]',
    "",
    "欄位規則：",
    "- no：題號（照卷面上的編號，字串）",
    "- type：choice（選擇題／是非題）、fill（填空、單行短答）、hand（需要計算、作圖、長文，得手寫）",
    "- x,y,w,h：作答區左上角座標與寬高，全部是 0~1 之間、相對於整張影像的比例",
    "- 選擇題的作答區請框「選項那一列」或「答案格」，不要框整段題目文字",
    "- options：選擇題的選項代號陣列（例如 A B C D 或 甲乙丙丁）；非選擇題給空陣列",
    "- score：這題配分，看不出來就填 5",
    "",
    "找不到任何題目時回傳空陣列 []。寧可少框也不要框錯位置。",
  ].join("\n");

  try {
    const parsed = await geminiJson(
      env,
      [
        { text: prompt },
        {
          inlineData: {
            mimeType: (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg",
            data: arrayBufferToBase64(buf),
          },
        },
      ],
      8192
    );
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.regions) ? parsed.regions : [];
    const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    const regions = list.slice(0, 100).map((r, i) => ({
      id: "p" + page + "q" + (i + 1) + "_" + Math.random().toString(36).slice(2, 7),
      page,
      no: String(r.no || i + 1),
      type: ["choice", "fill", "hand"].includes(r.type) ? r.type : "fill",
      x: clamp(r.x),
      y: clamp(r.y),
      w: Math.max(0.02, clamp(r.w)),
      h: Math.max(0.02, clamp(r.h)),
      label: String(r.label || "第" + (r.no || i + 1) + "題").slice(0, 60),
      options: Array.isArray(r.options) ? r.options.slice(0, 10).map((o) => String(o).slice(0, 6)) : [],
      score: Number(r.score) > 0 ? Number(r.score) : 5,
    }));
    return json({ regions, page });
  } catch (err) {
    return json({ error: { message: err.message } }, 502);
  }
}

// ---- 老師微調存檔 ----
async function handlePaperUpdate(request, env, paperId) {
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子，可能已過期" } }, 404);
  if (!(await isPaperOwner(request, env, paperId))) {
    return json({ error: { message: "只有這份卷子的老師可以修改" } }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: { message: "格式錯誤" } }, 400);
  }

  const sets = [];
  const binds = [];
  if (typeof body.title === "string") {
    sets.push("title = ?");
    binds.push(body.title.slice(0, 200));
  }
  if (Array.isArray(body.regions)) {
    sets.push("regions_json = ?");
    binds.push(JSON.stringify(body.regions.slice(0, 300)));
  }
  if (body.answerKey && typeof body.answerKey === "object") {
    sets.push("answer_key_json = ?");
    binds.push(JSON.stringify(body.answerKey));
  }
  if (body.status === "draft" || body.status === "published") {
    sets.push("status = ?");
    binds.push(body.status);
  }
  if (sets.length === 0) return json({ ok: true });

  binds.push(paperId);
  try {
    const stmt = env.DB.prepare("UPDATE papers SET " + sets.join(", ") + " WHERE id = ?");
    await stmt.bind(...binds).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

// ---- 讀卷子資訊 ----
// 學生只拿得到題目與作答區；標準答案只在確認是老師時才附上。
async function handlePaperGet(request, env, paperId) {
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子，可能已過期或連結錯誤" } }, 404);

  const out = {
    id: paper.id,
    title: paper.title,
    pageCount: Number(paper.page_count),
    status: paper.status,
    regions: safeParse(paper.regions_json, []),
    createdAt: Number(paper.created_at),
    expiresAt: Number(paper.expires_at),
  };
  if (await isPaperOwner(request, env, paperId)) {
    out.answerKey = safeParse(paper.answer_key_json, {});
    out.isOwner = true;
  }
  return json(out);
}

async function handlePaperDelete(request, env, paperId) {
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子" } }, 404);
  if (!(await isPaperOwner(request, env, paperId))) {
    return json({ error: { message: "只有這份卷子的老師可以刪除" } }, 403);
  }
  try {
    const prefixes = ["papers/" + paperId + "/", "subs/" + paperId + "/"];
    for (const prefix of prefixes) {
      let cursor;
      do {
        const listed = await env.PAPERS_R2.list({ prefix, cursor });
        if (listed.objects.length) {
          await env.PAPERS_R2.delete(listed.objects.map((o) => o.key));
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
    await env.DB.prepare("DELETE FROM paper_submissions WHERE paper_id = ?").bind(paperId).run();
    await env.DB.prepare("DELETE FROM papers WHERE id = ?").bind(paperId).run();
    await env.COOLDOWN_KV.delete("dashkey:" + paperId);
    return json({ ok: true });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

// 選擇／填空的自動比對。手寫題一律不在這裡判分，交給老師（可按「AI 協助批改」拿建議）。
function autoGradeAnswer(region, given, want) {
  const norm = (s) =>
    String(s == null ? "" : s)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[，。、．.,]/g, "");
  if (region.type === "hand") return null;
  if (want === undefined || want === null || String(want).trim() === "") return null;
  return norm(given) === norm(want) ? 1 : 0;
}

// ---- 學生送出作答 ----
async function handlePaperSubmit(request, env, paperId) {
  if (!env.PAPERS_R2) return json({ error: { message: "伺服器尚未開通原卷儲存空間（R2）" } }, 503);
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子，可能已過期" } }, 404);

  const raw = await request.text();
  if (raw.length > SUBMIT_MAX_BYTES) {
    return json({ error: { message: "作答內容太大，請減少手寫塗鴉的範圍後再送出" } }, 413);
  }
  const body = safeParse(raw, null);
  if (!body) return json({ error: { message: "格式錯誤" } }, 400);

  const clientId = (request.headers.get("X-Client-Id") || "").trim();
  const session = await verifySession(request, env);
  const studentId = String(body.studentId || (session ? "u" + session.uid : clientId) || "").trim();
  if (!studentId) return json({ error: { message: "缺少學生識別碼" } }, 400);

  const regions = safeParse(paper.regions_json, []);
  const answerKey = safeParse(paper.answer_key_json, {});
  const given = body.answers && typeof body.answers === "object" ? body.answers : {};

  const answers = {};
  const auto = {};
  let score = 0;
  let maxScore = 0;
  let hasHand = false;

  for (const region of regions) {
    const rScore = Number(region.score) > 0 ? Number(region.score) : 0;
    maxScore += rScore;
    const a = given[region.id];
    if (!a) continue;

    if (typeof a.img === "string" && a.img.indexOf("data:image/") === 0) {
      // 手寫作答：把該作答區的塗鴉截圖存進 R2，D1 只留 key
      const b64 = a.img.split(",")[1] || "";
      const bytes = base64ToBytes(b64);
      if (bytes.length > HAND_MAX_BYTES) {
        return json({ error: { message: "第 " + region.no + " 題的手寫內容太大，請簡化後再送出" } }, 413);
      }
      const key = "subs/" + paperId + "/" + studentId + "/" + region.id + ".png";
      await env.PAPERS_R2.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
      answers[region.id] = { img: key };
      hasHand = true;
      continue;
    }

    const v = String(a.v == null ? "" : a.v).slice(0, 2000);
    answers[region.id] = { v };
    const ok = autoGradeAnswer(region, v, answerKey[region.id]);
    if (ok !== null) {
      auto[region.id] = { ok, got: v, want: String(answerKey[region.id]) };
      if (ok === 1) score += rScore;
    }
  }

  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO paper_submissions" +
        " (paper_id, student_id, student_username, grade, class_name, seat, name," +
        "  answers_json, auto_json, ai_json, teacher_json, marks_json, score, max_score, status, submitted_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', '[]', ?, ?, 'submitted', ?, ?)" +
        " ON CONFLICT(paper_id, student_id) DO UPDATE SET" +
        "   student_username = excluded.student_username," +
        "   grade = excluded.grade, class_name = excluded.class_name," +
        "   seat = excluded.seat, name = excluded.name," +
        "   answers_json = excluded.answers_json, auto_json = excluded.auto_json," +
        "   score = excluded.score, max_score = excluded.max_score," +
        "   status = 'submitted', updated_at = excluded.updated_at"
    )
      .bind(
        paperId,
        studentId,
        session && session.username ? String(session.username) : "",
        String(body.grade || "").slice(0, 20),
        String(body.className || "").slice(0, 40),
        String(body.seat || "").slice(0, 10),
        String(body.name || "").slice(0, 40),
        JSON.stringify(answers),
        JSON.stringify(auto),
        score,
        maxScore,
        now,
        now
      )
      .run();

    return json({
      ok: true,
      score,
      maxScore,
      auto,
      // 有手寫題就老實說分數還沒算完，不要讓學生以為這是最終成績
      pending: hasHand,
    });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}

// ---- 老師端：全班作答清單 ----
async function handlePaperSubmissionList(request, env, paperId) {
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子" } }, 404);
  if (!(await isPaperOwner(request, env, paperId))) {
    return json({ error: { message: "需要老師的批改連結才能看全班成績" } }, 403);
  }
  const rows = await env.DB.prepare(
    "SELECT student_id, name, seat, class_name, grade, score, max_score, status, submitted_at, updated_at" +
      " FROM paper_submissions WHERE paper_id = ? ORDER BY seat, submitted_at"
  ).bind(paperId).all();
  return json({ submissions: rows.results || [] });
}

// ---- 單筆作答：老師看得到，學生看得到自己的，家長看得到已連結孩子的 ----
async function canReadSubmission(request, env, paperId, studentId) {
  if (await isPaperOwner(request, env, paperId)) return true;
  const clientId = (request.headers.get("X-Client-Id") || "").trim();
  if (clientId && clientId === studentId) return true;
  const session = await verifySession(request, env);
  if (!session) return false;
  if ("u" + session.uid === studentId) return true;
  if (session.role === "parent") {
    const row = await env.DB.prepare(
      "SELECT 1 FROM paper_submissions s" +
        " JOIN users u ON u.username = s.student_username" +
        " JOIN parent_child_links l ON l.student_id = u.id" +
        " WHERE l.parent_id = ? AND s.paper_id = ? AND s.student_id = ? LIMIT 1"
    ).bind(session.uid, paperId, studentId).first();
    return !!row;
  }
  return false;
}

async function handlePaperSubmissionGet(request, env, paperId, studentId) {
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子" } }, 404);
  if (!(await canReadSubmission(request, env, paperId, studentId))) {
    return json({ error: { message: "沒有權限看這份作答" } }, 403);
  }
  const row = await env.DB.prepare(
    "SELECT * FROM paper_submissions WHERE paper_id = ? AND student_id = ?"
  ).bind(paperId, studentId).first();
  if (!row) return json({ error: { message: "這位學生還沒有作答紀錄" } }, 404);

  return json({
    studentId: row.student_id,
    name: row.name,
    seat: row.seat,
    className: row.class_name,
    grade: row.grade,
    answers: safeParse(row.answers_json, {}),
    auto: safeParse(row.auto_json, {}),
    ai: safeParse(row.ai_json, {}),
    teacher: safeParse(row.teacher_json, {}),
    marks: safeParse(row.marks_json, []),
    score: row.score,
    maxScore: row.max_score,
    status: row.status,
    submittedAt: Number(row.submitted_at),
    updatedAt: Number(row.updated_at),
  });
}

// ---- 學生手寫作答的截圖 ----
async function handlePaperHandGet(request, env, paperId, studentId, regionIdRaw) {
  if (!env.PAPERS_R2) return json({ error: { message: "伺服器尚未開通原卷儲存空間（R2）" } }, 503);
  if (!(await canReadSubmission(request, env, paperId, studentId))) {
    return json({ error: { message: "沒有權限看這份作答" } }, 403);
  }
  const regionId = regionIdRaw.replace(/\.png$/, "");
  const obj = await env.PAPERS_R2.get("subs/" + paperId + "/" + studentId + "/" + regionId + ".png");
  if (!obj) return json({ error: { message: "找不到這一題的手寫內容" } }, 404);
  return new Response(obj.body, {
    headers: Object.assign({}, CORS_HEADERS, {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=600",
    }),
  });
}

// ---- AI 協助批改（老師按鈕才觸發，建議分數不會自動生效）----
// 一次把這位學生所有手寫題送給 Gemini，回建議分數與評語。Gemini 免費層每個模型每天 20 次，
// 所以刻意做成「一位學生一次呼叫」而不是「一題一次」，30 人班級批完是 30 次而不是幾百次。
async function handlePaperAiGrade(request, env, paperId, studentId) {
  if (!env.PAPERS_R2) return json({ error: { message: "伺服器尚未開通原卷儲存空間（R2）" } }, 503);
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子" } }, 404);
  if (!(await isPaperOwner(request, env, paperId))) {
    return json({ error: { message: "只有老師可以使用 AI 協助批改" } }, 403);
  }

  const row = await env.DB.prepare(
    "SELECT * FROM paper_submissions WHERE paper_id = ? AND student_id = ?"
  ).bind(paperId, studentId).first();
  if (!row) return json({ error: { message: "這位學生還沒有作答紀錄" } }, 404);

  const regions = safeParse(paper.regions_json, []);
  const answerKey = safeParse(paper.answer_key_json, {});
  const answers = safeParse(row.answers_json, {});

  const parts = [];
  const wanted = [];
  for (const region of regions) {
    const a = answers[region.id];
    if (!a || !a.img) continue;
    const obj = await env.PAPERS_R2.get(a.img);
    if (!obj) continue;
    const max = Number(region.score) > 0 ? Number(region.score) : 5;
    wanted.push({ id: region.id, no: region.no, score: max });
    parts.push({
      text:
        "以下是第 " + region.no + " 題（作答區代號 " + region.id + "，滿分 " + max + " 分" +
        (answerKey[region.id] ? "，參考答案：" + answerKey[region.id] : "，沒有提供參考答案") +
        "）的學生手寫作答：",
    });
    parts.push({ inlineData: { mimeType: "image/png", data: arrayBufferToBase64(await obj.arrayBuffer()) } });
  }

  if (wanted.length === 0) {
    return json({ error: { message: "這位學生沒有手寫題需要 AI 協助批改" } }, 400);
  }

  parts.unshift({
    text: [
      "你是台灣國中小老師的批改助手。以下是一位學生的手寫作答影像，請逐題判讀並給建議分數。",
      "",
      "注意事項：",
      "- 學生是小孩，字跡潦草是常態。看不清楚就在 comment 說明「字跡難以辨識」，不要亂猜。",
      "- 有參考答案時以參考答案為準；沒有參考答案時就依作答過程的合理性給分。",
      "- 計算題請看過程，過程對但算錯給部分分數。",
      "- comment 用繁體中文、台灣用語，寫給小學生看得懂，20 字以內，語氣鼓勵但要指出錯在哪。",
      "",
      "只回 JSON 陣列，不要任何說明文字：",
      '[{"id":"作答區代號","score":3,"comment":"步驟對，最後一步進位算錯"}]',
      "",
      "作答區代號必須原樣使用，不要自己編。",
    ].join("\n"),
  });

  try {
    const parsed = await geminiJson(env, parts, 4096);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.results) ? parsed.results : [];
    const byId = {};
    for (const w of wanted) byId[w.id] = w;
    const ai = safeParse(row.ai_json, {});
    for (const r of list) {
      const id = String(r.id || "");
      if (!byId[id]) continue;
      ai[id] = {
        score: Math.min(byId[id].score, Math.max(0, Number(r.score) || 0)),
        comment: String(r.comment || "").slice(0, 100),
      };
    }
    await env.DB.prepare("UPDATE paper_submissions SET ai_json = ?, updated_at = ? WHERE paper_id = ? AND student_id = ?")
      .bind(JSON.stringify(ai), Date.now(), paperId, studentId)
      .run();
    return json({ ok: true, ai });
  } catch (err) {
    return json({ error: { message: err.message } }, 502);
  }
}

// ---- 老師確認批改（最終分數以這裡為準）----
async function handlePaperSubmissionGrade(request, env, paperId, studentId) {
  const paper = await getPaperRow(env, paperId);
  if (!paper) return json({ error: { message: "找不到這份卷子" } }, 404);
  if (!(await isPaperOwner(request, env, paperId))) {
    return json({ error: { message: "只有老師可以批改" } }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: { message: "格式錯誤" } }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT * FROM paper_submissions WHERE paper_id = ? AND student_id = ?"
  ).bind(paperId, studentId).first();
  if (!row) return json({ error: { message: "這位學生還沒有作答紀錄" } }, 404);

  const regions = safeParse(paper.regions_json, []);
  const auto = safeParse(row.auto_json, {});
  const teacher = body.teacher && typeof body.teacher === "object" ? body.teacher : safeParse(row.teacher_json, {});
  const marks = Array.isArray(body.marks) ? body.marks.slice(0, 500) : safeParse(row.marks_json, []);

  // 總分重算：老師給過分的題以老師為準，其餘用自動判分的結果
  let score = 0;
  let maxScore = 0;
  for (const region of regions) {
    const rScore = Number(region.score) > 0 ? Number(region.score) : 0;
    maxScore += rScore;
    const t = teacher[region.id];
    if (t && t.score !== undefined && t.score !== null && t.score !== "") {
      score += Math.min(rScore, Math.max(0, Number(t.score) || 0));
    } else if (auto[region.id] && auto[region.id].ok === 1) {
      score += rScore;
    }
  }

  try {
    await env.DB.prepare(
      "UPDATE paper_submissions" +
        " SET teacher_json = ?, marks_json = ?, score = ?, max_score = ?, status = ?, updated_at = ?" +
        " WHERE paper_id = ? AND student_id = ?"
    )
      .bind(
        JSON.stringify(teacher),
        JSON.stringify(marks),
        score,
        maxScore,
        body.status === "graded" ? "graded" : row.status,
        Date.now(),
        paperId,
        studentId
      )
      .run();
    return json({ ok: true, score, maxScore });
  } catch (err) {
    return json({ error: { message: err.message } }, 500);
  }
}
