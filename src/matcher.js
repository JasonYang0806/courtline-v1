import { hydrateEvent } from './db.js';
import { extractTournamentEmail } from './extractor.js';

export function buildCanonicalKey(eventName, sourceLeague = '') {
  const base = `${eventName || ''} ${sourceLeague || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return base || 'event';
}

function findMatchingEvent(existingEvents, extracted) {
  const targetName = (extracted.event_name || '').toLowerCase().trim();
  const targetSession = targetName.match(/session\s+(\d+)/i)?.[1];

  for (const ev of existingEvents) {
    const evName = ev.event_name.toLowerCase().trim();
    if (evName === targetName) return ev;
    if (evName.includes(targetName) || targetName.includes(evName)) return ev;
    if (targetSession && evName.includes(targetSession)) return ev;
  }

  // Fuzzy token overlap within same league
  const stop = new Set(['usta', 'utr', 'tennis', 'team', 'teams', 'junior', 'level', 'session', 'league', 'leagues', 'bay', 'area', 'match', 'event']);
  const targetTokens = targetName.split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !stop.has(t));
  if (!targetTokens.length) return null;

  let best = null;
  let bestScore = 0;
  for (const ev of existingEvents) {
    const evTokens = ev.event_name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !stop.has(t));
    if (!evTokens.length) continue;
    const overlap = targetTokens.filter((t) => evTokens.includes(t)).length;
    const score = overlap / Math.max(targetTokens.length, evTokens.length);
    if (overlap >= 2 || (overlap >= 1 && score >= 0.5)) {
      if (score > bestScore) {
        bestScore = score;
        best = ev;
      }
    }
  }
  return best;
}

/**
 * Ingest a forwarded email for a kid:
 * 1. Extract structured fields (LLM or local parser, or pre-supplied extracted payload for seeding)
 * 2. Match against existing kid events or create a new event
 * 3. Persist the raw email + extracted JSON
 * 4. Generate alerts when a draw posts, time changes, venue moves, deadline appears, or player withdraws
 */
export async function ingestEmailForKid(db, kid, emailInput, options = {}) {
  const from_address = String(emailInput.from_address || 'forwarded@parent.mail').trim();
  const subject = String(emailInput.subject || '(No subject)').trim();
  const body = String(emailInput.body || '').trim();
  const received_at = emailInput.received_at || new Date().toISOString();

  if (!body && !subject) {
    throw new Error('Email subject or body is required.');
  }

  const existingEvents = db.prepare('SELECT * FROM events WHERE kid_id = ?').all(kid.id).map(hydrateEvent);

  let extracted;
  let provider;
  if (options.preExtracted) {
    extracted = options.preExtracted;
    provider = options.provider || 'seeded';
  } else {
    const result = await extractTournamentEmail(
      { from_address, subject, body, received_at },
      existingEvents
    );
    extracted = result.extracted;
    provider = result.provider;
  }

  const now = options.timestamp || received_at || new Date().toISOString();
  const matched = findMatchingEvent(existingEvents, extracted);
  const createdAlerts = [];
  let eventId;
  let action;

  if (!matched) {
    action = 'created';
    const notes = [];
    if (extracted.update_summary) {
      notes.push({ at: now, type: extracted.change_type || 'new_event', text: extracted.update_summary });
    }
    const isWithdrawn = extracted.status === 'withdrawn';
    const isPlayed = isWithdrawn ? 0 : (extracted.status === 'completed' ? 1 : 0);

    const insertRes = db.prepare(`
      INSERT INTO events (
        kid_id, canonical_key, event_name, source_league, division,
        event_date, date_label, match_time, match_time_note,
        venue, previous_venue, venue_note,
        fee_amount, fee_label, fee_paid_date,
        format, deadline_date, deadline_label,
        status, withdrawal_reason, is_played_match, draw_published,
        schedule_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      kid.id,
      buildCanonicalKey(extracted.event_name, extracted.source_league),
      extracted.event_name,
      extracted.source_league,
      extracted.division,
      extracted.event_date,
      extracted.date_label,
      extracted.match_time,
      extracted.match_time_note,
      extracted.venue,
      extracted.previous_venue,
      extracted.venue_note,
      extracted.fee_amount,
      extracted.fee_label,
      extracted.fee_paid_date,
      extracted.format,
      extracted.deadline_date,
      extracted.deadline_label,
      extracted.status,
      extracted.withdrawal_reason,
      isPlayed,
      extracted.draw_published ? 1 : 0,
      JSON.stringify(notes),
      now,
      now
    );
    eventId = Number(insertRes.lastInsertRowid);
  } else {
    action = 'updated';
    eventId = matched.id;

    const nextNotes = Array.isArray(matched.schedule_notes) ? [...matched.schedule_notes] : [];
    if (extracted.update_summary) {
      nextNotes.push({ at: now, type: extracted.change_type || 'update', text: extracted.update_summary });
    }

    const nextVenue = extracted.venue || matched.venue;
    let nextPreviousVenue = matched.previous_venue;
    let nextVenueNote = extracted.venue_note || matched.venue_note;
    if (extracted.venue && matched.venue && extracted.venue.toLowerCase() !== matched.venue.toLowerCase()) {
      nextPreviousVenue = matched.venue;
      nextVenueNote = extracted.venue_note || `Moved from ${matched.venue}`;
    } else if (extracted.previous_venue) {
      nextPreviousVenue = extracted.previous_venue;
    }

    const nextDrawPublished = Boolean(matched.draw_published || extracted.draw_published);
    let nextStatus = matched.status;
    if (extracted.status === 'withdrawn') {
      nextStatus = 'withdrawn';
    } else if (matched.status !== 'withdrawn') {
      if (extracted.status === 'draw_posted' || (!matched.draw_published && extracted.draw_published)) {
        nextStatus = 'draw_posted';
      } else if (extracted.status === 'scheduled' && matched.status !== 'draw_posted') {
        nextStatus = 'scheduled';
      } else if (extracted.status === 'completed') {
        nextStatus = 'completed';
      } else if (extracted.status === 'awaiting_schedule' && !nextDrawPublished) {
        nextStatus = 'awaiting_schedule';
      }
    }

    const nextIsPlayed = nextStatus === 'withdrawn'
      ? 0
      : (nextStatus === 'completed' ? 1 : (matched.is_played_match ? 1 : 0));

    // If a draw was just posted, replace "No match schedule published yet" note unless a new note was supplied
    let nextMatchTimeNote = extracted.match_time_note || matched.match_time_note;
    if (nextDrawPublished && nextMatchTimeNote && /no match schedule published yet/i.test(nextMatchTimeNote)) {
      nextMatchTimeNote = extracted.match_time_note && !/no match schedule published yet/i.test(extracted.match_time_note)
        ? extracted.match_time_note
        : null;
    }

    db.prepare(`
      UPDATE events SET
        source_league = ?,
        division = ?,
        event_date = ?,
        date_label = ?,
        match_time = ?,
        match_time_note = ?,
        venue = ?,
        previous_venue = ?,
        venue_note = ?,
        fee_amount = ?,
        fee_label = ?,
        fee_paid_date = ?,
        format = ?,
        deadline_date = ?,
        deadline_label = ?,
        status = ?,
        withdrawal_reason = ?,
        is_played_match = ?,
        draw_published = ?,
        schedule_notes = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      extracted.source_league || matched.source_league,
      extracted.division || matched.division,
      extracted.event_date || matched.event_date,
      extracted.date_label || matched.date_label,
      extracted.match_time || matched.match_time,
      nextMatchTimeNote,
      nextVenue,
      nextPreviousVenue,
      nextVenueNote,
      extracted.fee_amount ?? matched.fee_amount,
      extracted.fee_label || matched.fee_label,
      extracted.fee_paid_date || matched.fee_paid_date,
      extracted.format || matched.format,
      extracted.deadline_date || matched.deadline_date,
      extracted.deadline_label || matched.deadline_label,
      nextStatus,
      extracted.withdrawal_reason || matched.withdrawal_reason,
      nextIsPlayed,
      nextDrawPublished ? 1 : 0,
      JSON.stringify(nextNotes),
      now,
      eventId
    );
  }

  // Persist email row
  const emailRes = db.prepare(`
    INSERT INTO emails (
      kid_id, event_id, from_address, subject, received_at, body,
      extracted_json, extraction_provider, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    kid.id,
    eventId,
    from_address,
    subject,
    received_at,
    body,
    JSON.stringify(extracted),
    provider,
    now
  );
  const emailId = Number(emailRes.lastInsertRowid);

  // Determine alerts to create
  const alertsToInsert = [];

  if (!matched) {
    if (extracted.draw_published || extracted.change_type === 'draw_posted') {
      alertsToInsert.push({
        alert_type: 'draw_posted',
        severity: 'high',
        title: `Draw posted: ${extracted.event_name}`,
        message: extracted.update_summary,
        previous_value: 'No schedule',
        new_value: [extracted.date_label, extracted.match_time, extracted.venue].filter(Boolean).join(' · ') || 'Draw live'
      });
    }
    if (extracted.previous_venue && extracted.venue) {
      alertsToInsert.push({
        alert_type: 'venue_changed',
        severity: 'high',
        title: `Venue moved: ${extracted.event_name}`,
        message: extracted.venue_note || `Moved from ${extracted.previous_venue} to ${extracted.venue}.`,
        previous_value: extracted.previous_venue,
        new_value: extracted.venue
      });
    }
    if (extracted.deadline_label && !options.suppressNewEventAlerts) {
      alertsToInsert.push({
        alert_type: 'deadline_added',
        severity: 'medium',
        title: `Deadline: ${extracted.event_name}`,
        message: extracted.deadline_label,
        previous_value: null,
        new_value: extracted.deadline_label
      });
    }
  } else {
    // Compare against prior event state
    const venueMoved = extracted.venue && matched.venue &&
      extracted.venue.toLowerCase() !== matched.venue.toLowerCase();
    if (venueMoved || extracted.change_type === 'venue_changed') {
      alertsToInsert.push({
        alert_type: 'venue_changed',
        severity: 'high',
        title: `Venue changed: ${matched.event_name}`,
        message: extracted.update_summary || `Moved from ${matched.venue || extracted.previous_venue} to ${extracted.venue}.`,
        previous_value: matched.venue || extracted.previous_venue || 'Previous venue',
        new_value: extracted.venue || 'Updated venue'
      });
    }

    const drawJustPosted = (!matched.draw_published && extracted.draw_published) || extracted.change_type === 'draw_posted';
    if (drawJustPosted) {
      alertsToInsert.push({
        alert_type: 'draw_posted',
        severity: 'high',
        title: `Draw posted: ${matched.event_name}`,
        message: extracted.update_summary || 'Match schedule is now published.',
        previous_value: 'No schedule published',
        new_value: [extracted.date_label, extracted.match_time, extracted.venue].filter(Boolean).join(' · ') || 'Published'
      });
    }

    const timeChanged = !drawJustPosted && (
      extracted.change_type === 'time_changed' ||
      (extracted.match_time && matched.match_time && extracted.match_time.toLowerCase() !== matched.match_time.toLowerCase())
    );
    if (timeChanged) {
      alertsToInsert.push({
        alert_type: 'time_changed',
        severity: 'high',
        title: `Time update: ${matched.event_name}`,
        message: extracted.update_summary || `Match time updated to ${extracted.match_time}.`,
        previous_value: matched.match_time || matched.match_time_note || 'Original time',
        new_value: extracted.match_time || 'Updated time'
      });
    }

    if (extracted.status === 'withdrawn' && matched.status !== 'withdrawn') {
      alertsToInsert.push({
        alert_type: 'withdrawal',
        severity: 'info',
        title: `Marked as withdrawal: ${matched.event_name}`,
        message: extracted.withdrawal_reason || 'Recorded as a withdrawal, not a played match.',
        previous_value: matched.status.replace('_', ' '),
        new_value: 'Withdrawn (not played)'
      });
    }

    if (extracted.deadline_label && !matched.deadline_label) {
      alertsToInsert.push({
        alert_type: 'deadline_added',
        severity: 'medium',
        title: `Deadline added: ${matched.event_name}`,
        message: extracted.deadline_label,
        previous_value: null,
        new_value: extracted.deadline_label
      });
    }
  }

  for (const al of alertsToInsert) {
    const alertRes = db.prepare(`
      INSERT INTO alerts (
        kid_id, event_id, email_id, alert_type, severity,
        title, message, previous_value, new_value, is_read, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      kid.id,
      eventId,
      emailId,
      al.alert_type,
      al.severity,
      al.title,
      al.message,
      al.previous_value,
      al.new_value,
      options.markAlertsRead ? 1 : 0,
      now
    );
    createdAlerts.push(db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertRes.lastInsertRowid));
  }

  const event = hydrateEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(eventId));
  const email = db.prepare('SELECT * FROM emails WHERE id = ?').get(emailId);

  return {
    action,
    provider,
    extracted,
    event,
    email: { ...email, extracted },
    alerts: createdAlerts
  };
}
