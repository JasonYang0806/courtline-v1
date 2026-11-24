import { createKid, getKidBySlug } from './db.js';
import { ingestEmailForKid } from './matcher.js';

export const SAMPLE_FORWARD_EMAILS = [
  {
    id: 'utr-sunny-draw',
    label: 'Draw Posted: UTR Sunny Youngs Match #1',
    description: 'Publishes the first match time & venue for Mia’s pending UTR Sunny Youngs session and triggers a Draw Posted alert.',
    from_address: 'notifications@universaltennis.com',
    subject: 'Fwd: Draw Posted — UTR Sunny Youngs (Beginner Teams) Match #1',
    received_at: '2026-11-23T18:15:00-08:00',
    body: `Hello Mia Yang's family,

The match schedule is now live for UTR Sunny Youngs!

Event: UTR Sunny Youngs
Division: Beginner Teams
Match Date: Sun Nov 29, 2026
Match Time: 10:30 AM
Venue: Cupertino Sports Center
Format: Short sets to 4, no-ad scoring
Check-in Deadline: Nov 29, 2026 at 10:15 AM

Please arrive 15 minutes early for team warm-ups.
— Universal Tennis (UTR)`
  },
  {
    id: 'utr-sunny-time-change',
    label: 'Time Change: UTR Sunny Youngs moved to 1:15 PM',
    description: 'Simulates a tournament director email moving Match #1 from 10:30 AM to 1:15 PM and triggers a Time Changed alert.',
    from_address: 'director@sunnyyoungstennis.org',
    subject: 'Fwd: TIME CHANGE — UTR Sunny Youngs Sunday Match',
    received_at: '2026-11-28T16:40:00-08:00',
    body: `Hi Beginner Teams parents,

Quick schedule update for UTR Sunny Youngs tomorrow (Sun Nov 29, 2026) at Cupertino Sports Center:
Due to morning court resurfacing, Match #1 has been moved from 10:30 AM to 1:15 PM.

New Match Time: 1:15 PM
Venue: Cupertino Sports Center

Thanks for rolling with the change!
— Sunny Youngs Captain`
  },
  {
    id: 'battl-4320-schedule',
    label: 'Schedule + Deadline: Bay Area Tennis Team Leagues Session 4320',
    description: 'Adds kickoff date, venue, and roster deadline to Session 4320.',
    from_address: 'leagues@bayareatennisteamleagues.com',
    subject: 'Fwd: Schedule Posted — Bay Area Tennis Team Leagues, Session 4320',
    received_at: '2026-11-24T11:05:00-08:00',
    body: `Welcome to Bay Area Tennis Team Leagues, Session 4320!

Your Session 4320 match schedule has been posted:
Event: Bay Area Tennis Team Leagues, Session 4320
Division: 10U Green Team League
Match Date: Sat Dec 5, 2026
Match Time: 9:00 AM
Venue: Cuesta Park Tennis Courts, Mountain View
Lineup Deadline: Dec 3, 2026 by 8:00 PM

See you on the courts!`
  },
  {
    id: 'usta-new-event',
    label: 'New Registration: USTA NorCal Winter Level 6',
    description: 'Adds a brand-new USTA tournament with entry fee, division, venue, and withdrawal deadline.',
    from_address: 'no-reply@playtennis.usta.com',
    subject: 'Fwd: Registration Confirmed — USTA NorCal Winter Level 6 Open',
    received_at: '2026-11-25T14:20:00-08:00',
    body: `Registration Confirmed for Mia Yang

Tournament: USTA NorCal Winter Level 6 Open
Division: Girls' 10 & under Green
Date: Sat Dec 12, 2026
Venue: Taube Family Tennis Stadium, Stanford
Entry Fee: $68.00 paid Nov 25, 2026
Format: Two short sets to 4, 7-point tiebreak at 4-all
Withdraw Deadline: Dec 7, 2026 at 5:59 PM

Match times will be posted 48 hours before play. Match time only in the USTA app.`
  }
];

export async function seedDatabaseIfEmpty(db) {
  const existing = getKidBySlug(db, 'mia-yang');
  if (existing) {
    return existing;
  }

  const mia = createKid(db, {
    name: 'Mia Yang',
    division: '10-and-under Green division',
    slug: 'mia-yang'
  });

  // ---------------------------------------------------------------------------
  // Event 1: USTA Chance Through Sport Level 7 Junior Challenger
  // Built chronologically from 5 realistic forwarded parent emails:
  //   1) Initial registration (West Valley College, $75.13, Girls' 12 & under, up to 4 no-ad, time only in USTA app)
  //   2) Night-before venue move (West Valley College -> Mission College Santa Clara)
  //   3) Sunday morning wet courts delay to 2:00pm
  //   4) Sunday morning courts dried -> started on time
  //   5) Mia withdrew sick -> withdrawal, NOT a played match
  // ---------------------------------------------------------------------------
  await ingestEmailForKid(
    db,
    mia,
    {
      from_address: 'no-reply@playtennis.usta.com',
      subject: 'Fwd: Registration Confirmed — USTA Chance Through Sport Level 7 Junior Challenger',
      received_at: '2026-11-10T15:22:00-08:00',
      body: `Thank you for registering Mia Yang!

Tournament: USTA Chance Through Sport Level 7 Junior Challenger
League: USTA
Date: Sun Nov 22, 2026
Division: Girls' 12 & under
Venue: West Valley College
Entry Fee: $75.13
Format: Up to 4, no-ad

Note: Match time only in the USTA app. Please check the USTA app after draws post on Friday evening.`
    },
    {
      provider: 'seeded',
      timestamp: '2026-11-10T15:22:00-08:00',
      preExtracted: {
        event_name: 'USTA Chance Through Sport Level 7 Junior Challenger',
        source_league: 'USTA',
        division: "Girls' 12 & under",
        event_date: '2026-11-22',
        date_label: 'Sun Nov 22, 2026',
        match_time: null,
        match_time_note: 'Match time only in the USTA app',
        venue: 'West Valley College',
        previous_venue: null,
        venue_note: null,
        fee_amount: 75.13,
        fee_label: '$75.13 entry',
        fee_paid_date: '2026-11-10',
        format: 'Up to 4, no-ad',
        deadline_date: null,
        deadline_label: null,
        status: 'scheduled',
        withdrawal_reason: null,
        draw_published: true,
        change_type: 'new_event',
        update_summary: 'Registered in Girls’ 12 & under ($75.13 entry, format up to 4, no-ad). Match time only in the USTA app.'
      },
      markAlertsRead: true
    }
  );

  await ingestEmailForKid(
    db,
    mia,
    {
      from_address: 'director@chancethroughsport.org',
      subject: 'Fwd: VENUE MOVE for tomorrow — Chance Through Sport Level 7 Junior Challenger',
      received_at: '2026-11-21T19:42:00-08:00',
      body: `Players & Parents,

Important site change for tomorrow's USTA Chance Through Sport Level 7 Junior Challenger (Sun Nov 22, 2026):
The venue has been moved from West Valley College to Mission College Santa Clara.

New Venue: Mission College Santa Clara
Previous Venue: West Valley College

Format remains up to 4, no-ad. Continue checking the USTA app for your exact match time.`
    },
    {
      provider: 'seeded',
      timestamp: '2026-11-21T19:42:00-08:00',
      preExtracted: {
        event_name: 'USTA Chance Through Sport Level 7 Junior Challenger',
        source_league: 'USTA',
        division: "Girls' 12 & under",
        event_date: '2026-11-22',
        date_label: 'Sun Nov 22, 2026',
        match_time: null,
        match_time_note: 'Match time only in the USTA app',
        venue: 'Mission College Santa Clara',
        previous_venue: 'West Valley College',
        venue_note: 'Venue moved from West Valley College the night before',
        fee_amount: 75.13,
        fee_label: '$75.13 entry',
        fee_paid_date: '2026-11-10',
        format: 'Up to 4, no-ad',
        deadline_date: null,
        deadline_label: null,
        status: 'scheduled',
        withdrawal_reason: null,
        draw_published: true,
        change_type: 'venue_changed',
        update_summary: 'Venue moved from West Valley College to Mission College Santa Clara the night before.'
      },
      markAlertsRead: false
    }
  );

  await ingestEmailForKid(
    db,
    mia,
    {
      from_address: 'director@chancethroughsport.org',
      subject: 'Fwd: Weather Delay — Wet Courts at Mission College Santa Clara',
      received_at: '2026-11-22T07:15:00-08:00',
      body: `Good morning parents,

Due to overnight rain and wet courts at Mission College Santa Clara, matches for the USTA Chance Through Sport Level 7 Junior Challenger are delayed to 2:00pm.

We will email again once courts are inspected.`
    },
    {
      provider: 'seeded',
      timestamp: '2026-11-22T07:15:00-08:00',
      preExtracted: {
        event_name: 'USTA Chance Through Sport Level 7 Junior Challenger',
        source_league: 'USTA',
        division: "Girls' 12 & under",
        event_date: '2026-11-22',
        date_label: 'Sun Nov 22, 2026',
        match_time: 'Delayed to 2:00pm (wet courts)',
        match_time_note: 'Match time only in the USTA app',
        venue: 'Mission College Santa Clara',
        previous_venue: 'West Valley College',
        venue_note: 'Venue moved from West Valley College the night before',
        fee_amount: 75.13,
        fee_label: '$75.13 entry',
        fee_paid_date: '2026-11-10',
        format: 'Up to 4, no-ad',
        deadline_date: null,
        deadline_label: null,
        status: 'scheduled',
        withdrawal_reason: null,
        draw_published: true,
        change_type: 'time_changed',
        update_summary: 'Matches delayed by wet courts to 2:00pm.'
      },
      markAlertsRead: true
    }
  );

  await ingestEmailForKid(
    db,
    mia,
    {
      from_address: 'director@chancethroughsport.org',
      subject: 'Fwd: UPDATE — Courts Dried, Starting On Time!',
      received_at: '2026-11-22T08:50:00-08:00',
      body: `Update for USTA Chance Through Sport Level 7 Junior Challenger:

Good news — the courts at Mission College Santa Clara dried faster than expected! Matches will start on time rather than waiting until 2:00pm. Check the USTA app for your original court time.

Format: up to 4, no-ad.`
    },
    {
      provider: 'seeded',
      timestamp: '2026-11-22T08:50:00-08:00',
      preExtracted: {
        event_name: 'USTA Chance Through Sport Level 7 Junior Challenger',
        source_league: 'USTA',
        division: "Girls' 12 & under",
        event_date: '2026-11-22',
        date_label: 'Sun Nov 22, 2026',
        match_time: 'Started on time (after 2:00pm wet-court delay)',
        match_time_note: 'Match time only in the USTA app',
        venue: 'Mission College Santa Clara',
        previous_venue: 'West Valley College',
        venue_note: 'Venue moved from West Valley College the night before',
        fee_amount: 75.13,
        fee_label: '$75.13 entry',
        fee_paid_date: '2026-11-10',
        format: 'Up to 4, no-ad',
        deadline_date: null,
        deadline_label: null,
        status: 'scheduled',
        withdrawal_reason: null,
        draw_published: true,
        change_type: 'time_changed',
        update_summary: 'Courts dried — matches started on time after earlier wet-court delay to 2:00pm.'
      },
      markAlertsRead: false
    }
  );

  await ingestEmailForKid(
    db,
    mia,
    {
      from_address: 'director@chancethroughsport.org',
      subject: 'Fwd: Withdrawal Confirmed — Mia Yang (Girls’ 12 & under)',
      received_at: '2026-11-22T09:10:00-08:00',
      body: `Hi Mia's parents,

We have processed Mia Yang's withdrawal (sick) from the USTA Chance Through Sport Level 7 Junior Challenger (Girls' 12 & under). Hope Mia feels better soon!

This is recorded as a withdrawal and not a played match.`
    },
    {
      provider: 'seeded',
      timestamp: '2026-11-22T09:10:00-08:00',
      preExtracted: {
        event_name: 'USTA Chance Through Sport Level 7 Junior Challenger',
        source_league: 'USTA',
        division: "Girls' 12 & under",
        event_date: '2026-11-22',
        date_label: 'Sun Nov 22, 2026',
        match_time: 'Started on time (after 2:00pm wet-court delay)',
        match_time_note: 'Match time only in the USTA app',
        venue: 'Mission College Santa Clara',
        previous_venue: 'West Valley College',
        venue_note: 'Venue moved from West Valley College the night before',
        fee_amount: 75.13,
        fee_label: '$75.13 entry',
        fee_paid_date: '2026-11-10',
        format: 'Up to 4, no-ad',
        deadline_date: null,
        deadline_label: null,
        status: 'withdrawn',
        withdrawal_reason: 'Mia withdrew sick — recorded as a withdrawal, not a played match',
        draw_published: true,
        change_type: 'withdrawal',
        update_summary: 'Mia withdrew sick — logged as a withdrawal, not a played match.'
      },
      markAlertsRead: false
    }
  );

  // ---------------------------------------------------------------------------
  // Event 2: UTR Sunny Youngs — Beginner Teams, session started Nov 13 2026
  // ---------------------------------------------------------------------------
  await ingestEmailForKid(
    db,
    mia,
    {
      from_address: 'notifications@universaltennis.com',
      subject: 'Fwd: You’re in! UTR Sunny Youngs — Beginner Teams',
      received_at: '2026-11-13T10:05:00-08:00',
      body: `Welcome to UTR Sunny Youngs!

Player: Mia Yang
Event: UTR Sunny Youngs
Division: Beginner Teams
Session Start: Nov 13, 2026

No match schedule published yet. We'll email as soon as team captains post the first match draw.`
    },
    {
      provider: 'seeded',
      timestamp: '2026-11-13T10:05:00-08:00',
      preExtracted: {
        event_name: 'UTR Sunny Youngs',
        source_league: 'UTR',
        division: 'Beginner Teams',
        event_date: '2026-11-13',
        date_label: 'Session started Nov 13, 2026',
        match_time: null,
        match_time_note: 'No match schedule published yet',
        venue: null,
        previous_venue: null,
        venue_note: null,
        fee_amount: null,
        fee_label: null,
        fee_paid_date: null,
        format: null,
        deadline_date: null,
        deadline_label: null,
        status: 'awaiting_schedule',
        withdrawal_reason: null,
        draw_published: false,
        change_type: 'new_event',
        update_summary: 'Session started Nov 13, 2026 (Beginner Teams) — no match schedule published yet.'
      },
      markAlertsRead: true
    }
  );

  // ---------------------------------------------------------------------------
  // Event 3: UTR KK Phoenixes — Pearl Teams, session started Nov 12 2026
  // ---------------------------------------------------------------------------
  await ingestEmailForKid(
    db,
    mia,
    {
      from_address: 'notifications@universaltennis.com',
      subject: 'Fwd: Roster Confirmed — UTR KK Phoenixes (Pearl Teams)',
      received_at: '2026-11-12T16:30:00-08:00',
      body: `Hi Mia Yang's family,

Mia is confirmed on the roster for UTR KK Phoenixes.

Event: UTR KK Phoenixes
Division: Pearl Teams
Session Start: Nov 12, 2026

No match schedule published yet. Forward any draw or lineup email here once captains publish match dates.`
    },
    {
      provider: 'seeded',
      timestamp: '2026-11-12T16:30:00-08:00',
      preExtracted: {
        event_name: 'UTR KK Phoenixes',
        source_league: 'UTR',
        division: 'Pearl Teams',
        event_date: '2026-11-12',
        date_label: 'Session started Nov 12, 2026',
        match_time: null,
        match_time_note: 'No match schedule published yet',
        venue: null,
        previous_venue: null,
        venue_note: null,
        fee_amount: null,
        fee_label: null,
        fee_paid_date: null,
        format: null,
        deadline_date: null,
        deadline_label: null,
        status: 'awaiting_schedule',
        withdrawal_reason: null,
        draw_published: false,
        change_type: 'new_event',
        update_summary: 'Session started Nov 12, 2026 (Pearl Teams) — no match schedule published yet.'
      },
      markAlertsRead: true
    }
  );

  // ---------------------------------------------------------------------------
  // Event 4: Bay Area Tennis Team Leagues, Session 4320 — $36.49 paid Nov 20 2026
  // ---------------------------------------------------------------------------
  await ingestEmailForKid(
    db,
    mia,
    {
      from_address: 'billing@bayareatennisteamleagues.com',
      subject: 'Fwd: Payment Receipt — Bay Area Tennis Team Leagues, Session 4320',
      received_at: '2026-11-20T14:18:00-08:00',
      body: `Payment Receipt

Player: Mia Yang
League: Bay Area Tennis Team Leagues
Event: Bay Area Tennis Team Leagues, Session 4320
Division: 10-and-under Green
Amount Paid: $36.49 paid Nov 20, 2026

Thank you for registering for Session 4320! Match schedules and court assignments will be emailed once brackets are finalized.`
    },
    {
      provider: 'seeded',
      timestamp: '2026-11-20T14:18:00-08:00',
      preExtracted: {
        event_name: 'Bay Area Tennis Team Leagues, Session 4320',
        source_league: 'Bay Area Tennis Team Leagues',
        division: 'Session 4320 · 10U Green',
        event_date: null,
        date_label: 'Paid Nov 20, 2026 · Schedule pending',
        match_time: null,
        match_time_note: 'No match schedule published yet',
        venue: null,
        previous_venue: null,
        venue_note: null,
        fee_amount: 36.49,
        fee_label: '$36.49 paid Nov 20, 2026',
        fee_paid_date: '2026-11-20',
        format: null,
        deadline_date: null,
        deadline_label: null,
        status: 'registered',
        withdrawal_reason: null,
        draw_published: false,
        change_type: 'payment_receipt',
        update_summary: 'Paid $36.49 on Nov 20, 2026 for Session 4320.'
      },
      markAlertsRead: true
    }
  );

  return mia;
}
