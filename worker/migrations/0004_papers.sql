-- 原卷直上（學 Kami 的「靜態文件變互動作業」，但 AI 大腦用我們自己的）
--
-- 老師上傳現成考卷 PDF／掃描圖 → Gemini 視覺自動抓出每題的作答區座標 → 老師拖拉微調
-- → 產生分享連結給學生 → 學生在原卷影像上直接作答（選擇題點選、填空打字、計算題手寫）
-- → 老師在批改介面按「AI 協助批改」讀手寫給建議分數，老師確認才算數。
--
-- 影像本體放 R2（binding PAPERS_R2），D1 只存座標、答案與分數這些查得到、改得動的結構化資料。
-- 保留一學年（365 天），單卷最多 10 頁／5MB，由 worker 端把關。

CREATE TABLE IF NOT EXISTS papers (
  id               TEXT    PRIMARY KEY,          -- 12 碼隨機，同時是學生作答連結的 ID
  title            TEXT    NOT NULL DEFAULT '',
  owner_client_id  TEXT    NOT NULL DEFAULT '',  -- 未登入老師：瀏覽器裝置 ID
  owner_user_id    INTEGER REFERENCES users(id), -- 已登入老師
  page_count       INTEGER NOT NULL DEFAULT 0,
  total_bytes      INTEGER NOT NULL DEFAULT 0,   -- 已用容量，擋 5MB 上限
  -- 作答區：[{ id, page, x, y, w, h, type:'choice|fill|hand', label, options, score }]
  -- 座標一律存 0~1 正規化比例，前端不管螢幕多寬都能還原
  regions_json     TEXT    NOT NULL DEFAULT '[]',
  -- 標準答案：{ 作答區id: 答案字串 }，只有老師端（dashKey／出題者）拿得到
  answer_key_json  TEXT    NOT NULL DEFAULT '{}',
  status           TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_papers_owner   ON papers(owner_client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_papers_expires ON papers(expires_at);

CREATE TABLE IF NOT EXISTS paper_submissions (
  paper_id         TEXT    NOT NULL REFERENCES papers(id),
  student_id       TEXT    NOT NULL,             -- 未登入：瀏覽器裝置 ID；登入：帳號 id 字串
  student_username TEXT    NOT NULL DEFAULT '',  -- 有登入才有，家長端靠這欄反查（同 live_progress 的作法）
  grade            TEXT    NOT NULL DEFAULT '',
  class_name       TEXT    NOT NULL DEFAULT '',
  seat             TEXT    NOT NULL DEFAULT '',
  name             TEXT    NOT NULL DEFAULT '',
  -- 作答內容：{ 作答區id: { v: 文字答案 } | { img: R2 key } }，手寫題存 R2 key
  answers_json     TEXT    NOT NULL DEFAULT '{}',
  -- 自動判分結果：{ 作答區id: { ok:0|1, got, want } }，只涵蓋選擇／填空
  auto_json        TEXT    NOT NULL DEFAULT '{}',
  -- AI 協助批改建議（老師按鈕才產生）：{ 作答區id: { score, comment } }
  ai_json          TEXT    NOT NULL DEFAULT '{}',
  -- 老師最終批改：{ 作答區id: { score, comment } } ＋ 圈選標記
  teacher_json     TEXT    NOT NULL DEFAULT '{}',
  marks_json       TEXT    NOT NULL DEFAULT '[]',
  score            REAL,
  max_score        REAL    NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','graded')),
  submitted_at     INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (paper_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_subs_paper ON paper_submissions(paper_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_paper_subs_user  ON paper_submissions(student_username);
