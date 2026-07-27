-- 班級名稱本身要當作學生加入班級用的代碼(例如「六年1班」)，必須全站唯一才能用來查找
CREATE UNIQUE INDEX idx_classes_name_unique ON classes(name);
