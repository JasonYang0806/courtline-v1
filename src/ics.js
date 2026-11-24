/**
 * Minimal iCalendar (.ics) generator for a kid's schedule page.
 */

function escapeIcs(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function isoDateToIcsDate(iso) {
  return String(iso || '').replace(/-/g, '');
}

function nextIsoDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

export function generateKidIcs(scheduleData) {
  const { kid, events } = scheduleData;
  const nowStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Courtline//Youth Sports Schedule V1//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeIcs(`${kid.name} — Tournament Schedule`)}`
  ];

  for (const ev of events) {
    if (!ev.event_date) continue;
    const isWithdrawn = ev.status === 'withdrawn';
    const summaryPrefix = isWithdrawn ? '[WITHDRAWN] ' : '';
    const descParts = [
      `League: ${ev.source_league}`,
      ev.division ? `Division: ${ev.division}` : null,
      ev.match_time ? `Match Time: ${ev.match_time}` : null,
      ev.match_time_note ? `Note: ${ev.match_time_note}` : null,
      ev.venue_note ? `Venue Note: ${ev.venue_note}` : null,
      ev.format ? `Format: ${ev.format}` : null,
      ev.fee_label ? `Fee: ${ev.fee_label}` : null,
      ev.deadline_label ? `Deadline: ${ev.deadline_label}` : null,
      ev.withdrawal_reason ? `Withdrawal: ${ev.withdrawal_reason}` : null
    ].filter(Boolean);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:courtline-${kid.slug}-event-${ev.id}@courtline.app`);
    lines.push(`DTSTAMP:${nowStamp}`);
    lines.push(`DTSTART;VALUE=DATE:${isoDateToIcsDate(ev.event_date)}`);
    lines.push(`DTEND;VALUE=DATE:${nextIsoDay(ev.event_date)}`);
    lines.push(`SUMMARY:${escapeIcs(`${summaryPrefix}${ev.event_name}`)}`);
    if (ev.venue) {
      lines.push(`LOCATION:${escapeIcs(ev.venue)}`);
    }
    lines.push(`DESCRIPTION:${escapeIcs(descParts.join('\n'))}`);
    lines.push(`STATUS:${isWithdrawn ? 'CANCELLED' : 'CONFIRMED'}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
