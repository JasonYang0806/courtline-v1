import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'courtline.db');

export const INBOX_DOMAIN = process.env.COURTLINE_INBOX_DOMAIN || 'inbox.courtline.app';

let sharedDb = null;

export function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'player';
}

export function openDatabase(dbPath = process.env.COURTLINE_DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function getDb() {
  if (!sharedDb) {
    sharedDb = openDatabase();
  }
  return sharedDb;
}

export function resetDatabase(dbPath = process.env.COURTLINE_DB_PATH || DEFAULT_DB_PATH) {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
  }
  if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  return getDb();
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      division TEXT NOT NULL,
      inbox_email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid_id INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
      canonical_key TEXT NOT NULL,
      event_name TEXT NOT NULL,
      source_league TEXT NOT NULL,
      division TEXT,
      event_date TEXT,
      date_label TEXT,
      match_time TEXT,
      match_time_note TEXT,
      venue TEXT,
      previous_venue TEXT,
      venue_note TEXT,
      fee_amount REAL,
      fee_label TEXT,
      fee_paid_date TEXT,
      format TEXT,
      deadline_date TEXT,
      deadline_label TEXT,
      status TEXT NOT NULL DEFAULT 'registered',
      withdrawal_reason TEXT,
      is_played_match INTEGER NOT NULL DEFAULT 0,
      draw_published INTEGER NOT NULL DEFAULT 0,
      schedule_notes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_kid ON events(kid_id);
    CREATE INDEX IF NOT EXISTS idx_events_canonical ON events(kid_id, canonical_key);

    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid_id INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
      from_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      received_at TEXT NOT NULL,
      body TEXT NOT NULL,
      extracted_json TEXT NOT NULL,
      extraction_provider TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_emails_kid ON emails(kid_id);
    CREATE INDEX IF NOT EXISTS idx_emails_event ON emails(event_id);

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid_id INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_kid ON alerts(kid_id);
  `);
}

export function listKids(db) {
  const rows = db.prepare(`
    SELECT k.*,
      (SELECT COUNT(*) FROM events e WHERE e.kid_id = k.id) AS event_count,
      (SELECT COUNT(*) FROM alerts a WHERE a.kid_id = k.id AND a.is_read = 0) AS unread_alert_count
    FROM kids k
    ORDER BY k.id ASC
  `).all();
  return rows;
}

export function getKidBySlug(db, slug) {
  return db.prepare('SELECT * FROM kids WHERE slug = ?').get(slug) || null;
}

export function getKidByInboxEmail(db, inboxEmail) {
  const normalized = String(inboxEmail || '').trim().toLowerCase();
  const exact = db.prepare('SELECT * FROM kids WHERE LOWER(inbox_email) = ?').get(normalized);
  if (exact) return exact;
  // Also match local-part (e.g. mia-yang@anything)
  const localPart = normalized.split('@')[0];
  if (localPart) {
    return db.prepare('SELECT * FROM kids WHERE LOWER(slug) = ?').get(localPart) || null;
  }
  return null;
}

export function createKid(db, { name, division, slug: requestedSlug }) {
  const cleanName = String(name || '').trim();
  const cleanDivision = String(division || '').trim() || 'Youth Tennis';
  if (!cleanName) {
    throw new Error('Kid name is required.');
  }
  const baseSlug = slugify(requestedSlug || cleanName);
  let slug = baseSlug;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM kids WHERE slug = ?').get(slug)) {
    slug = `${baseSlug}-${suffix++}`;
  }
  const inboxEmail = `${slug}@${INBOX_DOMAIN}`;
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO kids (slug, name, division, inbox_email, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(slug, cleanName, cleanDivision, inboxEmail, now);

  return db.prepare('SELECT * FROM kids WHERE id = ?').get(result.lastInsertRowid);
}

export function hydrateEvent(row) {
  if (!row) return null;
  let scheduleNotes = [];
  try {
    scheduleNotes = JSON.parse(row.schedule_notes || '[]');
  } catch {
    scheduleNotes = [];
  }
  return {
    ...row,
    is_played_match: Boolean(row.is_played_match),
    draw_published: Boolean(row.draw_published),
    schedule_notes: scheduleNotes
  };
}

export function getKidScheduleData(db, slug) {
  const kid = getKidBySlug(db, slug);
  if (!kid) return null;

  const events = db.prepare(`
    SELECT * FROM events
    WHERE kid_id = ?
    ORDER BY
      CASE status
        WHEN 'draw_posted' THEN 1
        WHEN 'scheduled' THEN 2
        WHEN 'awaiting_schedule' THEN 3
        WHEN 'registered' THEN 4
        WHEN 'withdrawn' THEN 5
        ELSE 6
      END,
      COALESCE(event_date, '9999-99-99') DESC,
      id ASC
  `).all(kid.id).map(hydrateEvent);

  const emails = db.prepare(`
    SELECT * FROM emails
    WHERE kid_id = ?
    ORDER BY received_at DESC, id DESC
  `).all(kid.id).map((e) => {
    let extracted = {};
    try {
      extracted = JSON.parse(e.extracted_json || '{}');
    } catch {
      extracted = {};
    }
    return { ...e, extracted };
  });

  const alerts = db.prepare(`
    SELECT a.*, e.event_name, e.source_league
    FROM alerts a
    LEFT JOIN events e ON e.id = a.event_id
    WHERE a.kid_id = ?
    ORDER BY a.is_read ASC, a.created_at DESC, a.id DESC
  `).all(kid.id).map((a) => ({
    ...a,
    is_read: Boolean(a.is_read)
  }));

  // Group email summaries onto each event for quick provenance display
  const emailsByEvent = new Map();
  for (const email of emails) {
    if (!email.event_id) continue;
    if (!emailsByEvent.has(email.event_id)) {
      emailsByEvent.set(email.event_id, []);
    }
    emailsByEvent.get(email.event_id).push({
      id: email.id,
      from_address: email.from_address,
      subject: email.subject,
      received_at: email.received_at,
      body: email.body,
      extraction_provider: email.extraction_provider,
      extracted: email.extracted
    });
  }

  const enrichedEvents = events.map((ev) => ({
    ...ev,
    emails: emailsByEvent.get(ev.id) || []
  }));

  const totalFees = events.reduce((sum, ev) => sum + (typeof ev.fee_amount === 'number' ? ev.fee_amount : 0), 0);
  const playedMatchesCount = events.filter((ev) => ev.is_played_match && ev.status !== 'withdrawn').length;
  const withdrawnCount = events.filter((ev) => ev.status === 'withdrawn').length;
  const awaitingScheduleCount = events.filter((ev) => !ev.draw_published && ev.status !== 'withdrawn').length;
  const unreadAlertsCount = alerts.filter((a) => !a.is_read).length;

  return {
    kid,
    summary: {
      total_events: events.length,
      active_events: events.filter((ev) => ev.status !== 'withdrawn').length,
      awaiting_schedule_count: awaitingScheduleCount,
      played_matches_count: playedMatchesCount,
      withdrawn_count: withdrawnCount,
      total_fees: Number(totalFees.toFixed(2)),
      unread_alerts_count: unreadAlertsCount
    },
    alerts,
    events: enrichedEvents,
    emails
  };
}

export function markAlertRead(db, alertId, isRead = true) {
  db.prepare('UPDATE alerts SET is_read = ? WHERE id = ?').run(isRead ? 1 : 0, alertId);
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) || null;
}

export function markAllAlertsRead(db, kidId) {
  db.prepare('UPDATE alerts SET is_read = 1 WHERE kid_id = ?').run(kidId);
}
