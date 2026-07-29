-- 即時監考進度從 KV 搬到 D1。
-- 原因：KV 免費方案每日只有 1000 次寫入，而一次上報要寫 2~3 個 key
-- （進度、每日預算計數器、student-active 指標），一個 30 人班級考一次試
-- 就會把當天全站額度（冷卻、分享、造訪人次共用同一個 namespace）吃光。
-- D1 免費方案每日 10 萬列寫入，且 UPSERT 沒有 KV 的最終一致性延遲問題。
CREATE TABLE IF NOT EXISTS live_progress (
  share_id         TEXT    NOT NULL,
  student_id       TEXT    NOT NULL,
  student_username TEXT    NOT NULL DEFAULT '',
  grade            TEXT    NOT NULL DEFAULT '',
  class_name       TEXT    NOT NULL DEFAULT '',
  seat             TEXT    NOT NULL DEFAULT '',
  name             TEXT    NOT NULL DEFAULT '',
  answered         INTEGER NOT NULL DEFAULT 0,
  total            INTEGER NOT NULL DEFAULT 0,
  answers          TEXT    NOT NULL DEFAULT '[]',
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (share_id, student_id)
);

-- 老師儀表板：列出某份測驗的全班進度
CREATE INDEX IF NOT EXISTS idx_live_progress_share ON live_progress (share_id);

-- 家長端：用孩子的帳號反查「現在正在寫哪一份」（取代原本的 student-active: KV 指標）
CREATE INDEX IF NOT EXISTS idx_live_progress_username ON live_progress (student_username, updated_at);

-- D1 沒有 TTL，改由寫入時順手清掉逾期資料（見 worker 的 LIVE_PROGRESS_TTL_SECONDS）
CREATE INDEX IF NOT EXISTS idx_live_progress_updated ON live_progress (updated_at);
