import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppServer, parseRawEml } from '../server.js';
import { getKidScheduleData, openDatabase } from '../src/db.js';
import { generateKidIcs } from '../src/ics.js';
import { ingestEmailForKid } from '../src/matcher.js';
import { SAMPLE_FORWARD_EMAILS, seedDatabaseIfEmpty } from '../src/seed.js';

test('Mia Yang seed data matches every required event, detail, and withdrawal rule', async () => {
  const db = openDatabase(':memory:');
  await seedDatabaseIfEmpty(db);

  const data = getKidScheduleData(db, 'mia-yang');
  assert.ok(data, 'Mia Yang schedule should exist');
  assert.equal(data.kid.name, 'Mia Yang');
  assert.equal(data.kid.division, '10-and-under Green division');
  assert.equal(data.events.length, 4);

  // Summary checks: withdrawal is NOT counted as a played match; fees sum to $111.62
  assert.equal(data.summary.played_matches_count, 0);
  assert.equal(data.summary.withdrawn_count, 1);
  assert.equal(data.summary.total_fees, 111.62);

  // Event 1: USTA Chance Through Sport Level 7 Junior Challenger
  const usta = data.events.find((e) => e.event_name.includes('Chance Through Sport'));
  assert.ok(usta);
  assert.equal(usta.source_league, 'USTA');
  assert.equal(usta.event_date, '2026-11-22');
  assert.equal(usta.division, "Girls' 12 & under");
  assert.equal(usta.venue, 'Mission College Santa Clara');
  assert.equal(usta.previous_venue, 'West Valley College');
  assert.equal(usta.fee_amount, 75.13);
  assert.equal(usta.match_time_note, 'Match time only in the USTA app');
  assert.equal(usta.format, 'Up to 4, no-ad');
  assert.equal(usta.status, 'withdrawn');
  assert.equal(usta.is_played_match, false);
  assert.ok(usta.schedule_notes.some((n) => /2:00pm/i.test(n.text)));
  assert.ok(usta.schedule_notes.some((n) => /started on time/i.test(n.text)));

  // Event 2: UTR Sunny Youngs
  const sunny = data.events.find((e) => e.event_name === 'UTR Sunny Youngs');
  assert.ok(sunny);
  assert.equal(sunny.source_league, 'UTR');
  assert.equal(sunny.division, 'Beginner Teams');
  assert.equal(sunny.event_date, '2026-11-13');
  assert.equal(sunny.draw_published, false);
  assert.match(sunny.match_time_note, /no match schedule published yet/i);

  // Event 3: UTR KK Phoenixes
  const phoenix = data.events.find((e) => e.event_name === 'UTR KK Phoenixes');
  assert.ok(phoenix);
  assert.equal(phoenix.source_league, 'UTR');
  assert.equal(phoenix.division, 'Pearl Teams');
  assert.equal(phoenix.event_date, '2026-11-12');
  assert.equal(phoenix.draw_published, false);
  assert.match(phoenix.match_time_note, /no match schedule published yet/i);

  // Event 4: Bay Area Tennis Team Leagues, Session 4320
  const battl = data.events.find((e) => e.event_name.includes('Session 4320'));
  assert.ok(battl);
  assert.equal(battl.source_league, 'Bay Area Tennis Team Leagues');
  assert.equal(battl.fee_amount, 36.49);
  assert.equal(battl.fee_paid_date, '2026-11-20');

  // Seeded alerts include venue change + time change + withdrawal
  const alertTypes = new Set(data.alerts.map((a) => a.alert_type));
  assert.ok(alertTypes.has('venue_changed'));
  assert.ok(alertTypes.has('time_changed'));
  assert.ok(alertTypes.has('withdrawal'));

  db.close();
});

test('Forwarding a Draw Posted email and then a Time Change email updates the same event and fires alerts', async () => {
  const db = openDatabase(':memory:');
  const mia = await seedDatabaseIfEmpty(db);

  // 1. Forward UTR Sunny Youngs Draw Posted email
  const drawEmail = SAMPLE_FORWARD_EMAILS.find((s) => s.id === 'utr-sunny-draw');
  const drawResult = await ingestEmailForKid(db, mia, drawEmail);

  assert.equal(drawResult.action, 'updated', 'Should match existing UTR Sunny Youngs event');
  assert.equal(drawResult.event.event_name, 'UTR Sunny Youngs');
  assert.equal(drawResult.event.draw_published, true);
  assert.equal(drawResult.event.status, 'draw_posted');
  assert.equal(drawResult.event.match_time, '10:30 AM');
  assert.equal(drawResult.event.venue, 'Cupertino Sports Center');
  assert.ok(drawResult.alerts.some((a) => a.alert_type === 'draw_posted'), 'Should trigger draw_posted alert');

  // 2. Forward Time Change email moving 10:30 AM -> 1:15 PM
  const timeEmail = SAMPLE_FORWARD_EMAILS.find((s) => s.id === 'utr-sunny-time-change');
  const timeResult = await ingestEmailForKid(db, mia, timeEmail);

  assert.equal(timeResult.action, 'updated');
  assert.equal(timeResult.event.event_name, 'UTR Sunny Youngs');
  assert.equal(timeResult.event.match_time, '1:15 PM');
  const timeAlert = timeResult.alerts.find((a) => a.alert_type === 'time_changed');
  assert.ok(timeAlert, 'Should trigger time_changed alert');
  assert.equal(timeAlert.previous_value, '10:30 AM');
  assert.equal(timeAlert.new_value, '1:15 PM');

  // Total events should still be 4 (no duplicates!)
  const schedule = getKidScheduleData(db, 'mia-yang');
  assert.equal(schedule.events.length, 4);

  db.close();
});

test('HTTP server API, inbound webhook, raw .eml parsing, kid creation, and .ics export', async () => {
  const db = openDatabase(':memory:');
  await seedDatabaseIfEmpty(db);

  const server = createAppServer({ db });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Landing HTML renders
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /Courtline/);

    // Schedule API returns Mia Yang
    const schedRes = await fetch(`${baseUrl}/api/kids/mia-yang/schedule`);
    assert.equal(schedRes.status, 200);
    const sched = await schedRes.json();
    assert.equal(sched.kid.slug, 'mia-yang');
    assert.equal(sched.events.length, 4);

    // Inbound webhook routes by recipient email address (Postmark/Resend style)
    const webhookRes = await fetch(`${baseUrl}/api/inbound-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        To: 'Mia Yang <mia-yang@inbox.courtline.app>',
        From: 'no-reply@playtennis.usta.com',
        Subject: 'Fwd: Registration Confirmed — USTA Winter Classic',
        TextBody: 'Tournament: USTA Winter Classic\nDivision: Girls 10U Green\nDate: Sat Dec 19, 2026\nVenue: Sunnyvale Tennis Center\nEntry Fee: $65.00'
      })
    });
    assert.equal(webhookRes.status, 201);
    const webhookJson = await webhookRes.json();
    assert.equal(webhookJson.action, 'created');
    assert.equal(webhookJson.event.event_name, 'USTA Winter Classic');
    assert.equal(webhookJson.event.fee_amount, 65);

    // Create a brand-new kid page (zero accounts)
    const kidRes = await fetch(`${baseUrl}/api/kids`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Leo Chen', division: '12U Orange Ball' })
    });
    assert.equal(kidRes.status, 201);
    const { kid } = await kidRes.json();
    assert.equal(kid.slug, 'leo-chen');
    assert.match(kid.inbox_email, /^leo-chen@/);

    // Raw .eml parser check
    const eml = parseRawEml('From: coach@club.org\nSubject: Practice Match\n\nVenue: Park Courts\nMatch Time: 3:00 PM');
    assert.equal(eml.from_address, 'coach@club.org');
    assert.equal(eml.subject, 'Practice Match');
    assert.match(eml.body, /Park Courts/);

    // ICS export marks withdrawn event as CANCELLED
    const icsRes = await fetch(`${baseUrl}/api/kids/mia-yang/calendar.ics`);
    assert.equal(icsRes.status, 200);
    const icsText = await icsRes.text();
    assert.match(icsText, /BEGIN:VCALENDAR/);
    assert.match(icsText, /\[WITHDRAWN\] USTA Chance Through Sport/);
    assert.match(icsText, /STATUS:CANCELLED/);
  } finally {
    server.close();
    db.close();
  }
});
