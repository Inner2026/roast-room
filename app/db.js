'use strict';
// SQLite storage via Node's built-in node:sqlite (Node >= 22.5). No dependencies.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, decision TEXT NOT NULL, mode TEXT, status TEXT NOT NULL, events TEXT NOT NULL DEFAULT '[]', usd REAL NOT NULL DEFAULT 0, error TEXT, created INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id, created);`);
  return db;
}

function hash(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `s1$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verify(pw, stored) {
  const [v, s, h] = String(stored).split('$');
  if (v !== 's1') return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(h, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}

function store(db) {
  const q = (sql) => db.prepare(sql);
  const DAY = 86400000;
  return {
    createUser(email, pw) {
      const r = q('INSERT INTO users(email,pass,created) VALUES(?,?,?)').run(email, hash(pw), Date.now());
      return Number(r.lastInsertRowid);
    },
    userByEmail: (e) => q('SELECT * FROM users WHERE email=?').get(e),
    userById: (id) => q('SELECT id,email,plan,created FROM users WHERE id=?').get(id),
    verifyPass: verify,
    newSession(userId, days = 14) {
      const token = crypto.randomBytes(32).toString('hex');
      q('INSERT INTO sessions VALUES(?,?,?)').run(token, userId, Date.now() + days * DAY);
      return token;
    },
    sessionUser(token) {
      if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
      const s = q('SELECT * FROM sessions WHERE token=?').get(token);
      if (!s) return null;
      if (s.expires < Date.now()) { q('DELETE FROM sessions WHERE token=?').run(token); return null; }
      return this.userById(s.user_id);
    },
    endSession: (t) => q('DELETE FROM sessions WHERE token=?').run(t),
    createRun(id, userId, decision, mode) {
      q('INSERT INTO runs(id,user_id,decision,mode,status,created) VALUES(?,?,?,?,?,?)').run(id, userId, decision, mode || '', 'running', Date.now());
    },
    saveEvents: (id, events) => q('UPDATE runs SET events=? WHERE id=?').run(JSON.stringify(events), id),
    finishRun: (id, status, usd, error) => q('UPDATE runs SET status=?, usd=?, error=? WHERE id=?').run(status, usd || 0, error || null, id),
    getRun(id, userId) {
      const r = q('SELECT * FROM runs WHERE id=? AND user_id=?').get(id, userId);
      return r ? { ...r, events: JSON.parse(r.events) } : null;
    },
    listRuns: (userId) => q('SELECT id,decision,mode,status,usd,created FROM runs WHERE user_id=? ORDER BY created DESC LIMIT 100').all(userId),
    deleteRun: (id, userId) => q('DELETE FROM runs WHERE id=? AND user_id=?').run(id, userId).changes > 0,
    countRunsSince: (userId, since) => q('SELECT COUNT(*) n FROM runs WHERE user_id=? AND created>=?').get(userId, since).n,
    globalSince: (since) => q('SELECT COUNT(*) n, COALESCE(SUM(usd),0) usd FROM runs WHERE created>=?').get(since),
    failInterrupted: () => q("UPDATE runs SET status='failed', error='Server restarted during the run' WHERE status='running'").run(),
    deleteUser: (id) => q('DELETE FROM users WHERE id=?').run(id),
  };
}

module.exports = { open, store, hash, verify };
