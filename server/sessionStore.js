'use strict';

const fs = require('fs');
const path = require('path');

/**
 * In-memory session store, backed by a JSON file on disk so sessions
 * survive server restarts. The in-memory Map is still the source of
 * truth at runtime; the file is just a snapshot we load once at boot
 * and rewrite after every mutation.
 */
const SCHEMA_VERSION = 1;
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'sessions.json');

const sessions = new Map();

function migrate(record) {
  // Older snapshots (pre session_id-as-key) may be missing fields.
  // Add new migrations here as the schema evolves — keep them additive.
  if (!record.session_id && record.sessionId) {
    record.session_id = record.sessionId;
  }
  return record;
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    for (const entry of entries) {
      const record = migrate(entry);
      if (record && record.sessionId) {
        sessions.set(record.sessionId, record);
      }
    }
  } catch (err) {
    // Corrupted or unreadable file — don't crash the server, just
    // start with an empty store and warn loudly so it gets noticed.
    console.error('[sessionStore] failed to load sessions.json, starting empty:', err.message);
  }
}

function persistToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = { schema_version: SCHEMA_VERSION, sessions: [...sessions.values()] };
    // Write to a temp file then rename, so a crash mid-write can't
    // leave sessions.json half-written / corrupted.
    const tmpPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpPath, DB_PATH);
  } catch (err) {
    console.error('[sessionStore] failed to persist sessions.json:', err.message);
  }
}

loadFromDisk();

function createSession(sessionId, data) {
  sessions.set(sessionId, data);
  persistToDisk();
  return data;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function saveSession(sessionId, data) {
  sessions.set(sessionId, data);
  persistToDisk();
}

function deleteSession(sessionId) {
  sessions.delete(sessionId);
  persistToDisk();
}

/** Returns all sessions currently held in memory, newest first. */
function listSessions() {
  return [...sessions.values()].sort((a, b) => {
    const at = a.startedAt ? Date.parse(a.startedAt) : 0;
    const bt = b.startedAt ? Date.parse(b.startedAt) : 0;
    return bt - at;
  });
}

module.exports = { createSession, getSession, saveSession, deleteSession, listSessions };
