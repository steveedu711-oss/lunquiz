CREATE TABLE classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  teacher_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('student','parent','teacher','superadmin')),
  display_name TEXT NOT NULL,
  class_id INTEGER REFERENCES classes(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE parent_child_links (
  parent_id INTEGER NOT NULL REFERENCES users(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (parent_id, student_id)
);

CREATE TABLE quiz_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  title TEXT NOT NULL,
  items_json TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_history_class ON quiz_history(class_id, created_at);
CREATE INDEX idx_users_class ON users(class_id);
