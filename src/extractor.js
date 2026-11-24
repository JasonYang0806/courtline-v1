/**
 * Tournament Email Extractor
 *
 * Calls an LLM (Anthropic, OpenAI, or Gemini via native fetch) when an API key
 * is configured, and falls back to a deterministic structured parser so the
 * weekend V1 works out of the box with zero external keys or dependencies.
 */

const SYSTEM_PROMPT = `You extract structured youth sports tournament and league details from forwarded parent emails.
Return ONLY valid JSON matching this exact schema (use null when not stated in the email):
{
  "event_name": "string",
  "source_league": "string (e.g., USTA, UTR, Bay Area Tennis Team Leagues)",
  "division": "string | null",
  "event_date": "YYYY-MM-DD | null",
  "date_label": "string | null (e.g., 'Sun Nov 22, 2026' or 'Session started Nov 13, 2026')",
  "match_time": "string | null (e.g., '10:30 AM', '2:00 PM', 'Started on time')",
  "match_time_note": "string | null (e.g., 'Match time only in the USTA app', 'No match schedule published yet')",
  "venue": "string | null",
  "previous_venue": "string | null",
  "venue_note": "string | null",
  "fee_amount": "number | null",
  "fee_label": "string | null (e.g., '$75.13 entry' or '$36.49 paid Nov 20, 2026')",
  "fee_paid_date": "YYYY-MM-DD | null",
  "format": "string | null (e.g., 'Up to 4, no-ad')",
  "deadline_date": "YYYY-MM-DD | null",
  "deadline_label": "string | null",
  "status": "draw_posted | scheduled | awaiting_schedule | registered | withdrawn | completed",
  "withdrawal_reason": "string | null",
  "draw_published": "boolean",
  "change_type": "new_event | draw_posted | time_changed | venue_changed | withdrawal | deadline_added | payment_receipt | update",
  "update_summary": "string (1 concise sentence summarizing what this email states or changes)"
}

Rules:
- Never fabricate match times or venues not present in the email.
- If the email indicates the player withdrew (e.g., sick/injury/withdrawal confirmed), set status="withdrawn" and change_type="withdrawal".
- If the email says a match schedule or draw is not yet published, set status="awaiting_schedule" and draw_published=false.
- If the email posts a draw or first match time, set draw_published=true and change_type="draw_posted".
- If the email moves a match time or reports a weather delay/resumption, set change_type="time_changed".
- If the email moves the venue/location, set change_type="venue_changed" and populate both venue and previous_venue when mentioned.
- Match existing event names cleanly when an update email refers to an ongoing tournament/session.`;

export function getActiveExtractorInfo() {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      mode: 'llm',
      provider: 'anthropic',
      model: process.env.COURTLINE_LLM_MODEL || 'claude-3-5-haiku-latest',
      label: `Anthropic (${process.env.COURTLINE_LLM_MODEL || 'claude-3-5-haiku-latest'})`
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      mode: 'llm',
      provider: 'openai',
      model: process.env.COURTLINE_LLM_MODEL || 'gpt-4o-mini',
      label: `OpenAI (${process.env.COURTLINE_LLM_MODEL || 'gpt-4o-mini'})`
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      mode: 'llm',
      provider: 'gemini',
      model: process.env.COURTLINE_LLM_MODEL || 'gemini-2.5-flash',
      label: `Gemini (${process.env.COURTLINE_LLM_MODEL || 'gemini-2.5-flash'})`
    };
  }
  return {
    mode: 'local',
    provider: 'local-parser',
    model: 'deterministic-v1',
    label: 'Local Structured Extractor (add ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY for live LLM)'
  };
}

export async function extractTournamentEmail(emailInput, existingEvents = []) {
  const { from_address = '', subject = '', body = '', received_at = '' } = emailInput;
  const info = getActiveExtractorInfo();

  if (info.mode === 'llm') {
    try {
      const existingContext = existingEvents.length
        ? `\nExisting events on this kid's schedule (reuse exact event_name if this email updates one of them):\n` +
          existingEvents.map((e) => `- ${e.event_name} (${e.source_league}, ${e.division || 'n/a'}, status: ${e.status})`).join('\n')
        : '';

      const userPrompt = `From: ${from_address}\nSubject: ${subject}\nDate: ${received_at || new Date().toISOString()}${existingContext}\n\nEmail Body:\n${body}`;

      let rawJson = null;
      if (info.provider === 'anthropic') {
        rawJson = await callAnthropic(userPrompt, info.model);
      } else if (info.provider === 'openai') {
        rawJson = await callOpenAI(userPrompt, info.model);
      } else if (info.provider === 'gemini') {
        rawJson = await callGemini(userPrompt, info.model);
      }

      if (rawJson) {
        const parsed = normalizeExtracted(parseJsonObject(rawJson));
        return { extracted: parsed, provider: info.provider };
      }
    } catch (err) {
      console.warn(`[extractor] ${info.provider} call failed, falling back to local parser:`, err.message);
    }
  }

  const extracted = normalizeExtracted(localParseEmail({ from_address, subject, body, received_at }, existingEvents));
  return { extracted, provider: 'local-parser' };
}

async function callAnthropic(userPrompt, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.content?.map((c) => c.text || '').join('') || '';
}

async function callOpenAI(userPrompt, model) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(userPrompt, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

function parseJsonObject(raw) {
  const trimmed = String(raw || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No JSON object found in LLM response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function normalizeExtracted(obj) {
  const validStatuses = new Set(['draw_posted', 'scheduled', 'awaiting_schedule', 'registered', 'withdrawn', 'completed']);
  const status = validStatuses.has(obj.status) ? obj.status : 'registered';
  const feeAmount = typeof obj.fee_amount === 'number' && !Number.isNaN(obj.fee_amount)
    ? Number(obj.fee_amount.toFixed(2))
    : null;

  return {
    event_name: cleanStr(obj.event_name) || 'Untitled Youth Sports Event',
    source_league: cleanStr(obj.source_league) || 'League / Tournament',
    division: cleanStr(obj.division),
    event_date: cleanIsoDate(obj.event_date),
    date_label: cleanStr(obj.date_label),
    match_time: cleanStr(obj.match_time),
    match_time_note: cleanStr(obj.match_time_note),
    venue: cleanStr(obj.venue),
    previous_venue: cleanStr(obj.previous_venue),
    venue_note: cleanStr(obj.venue_note),
    fee_amount: feeAmount,
    fee_label: cleanStr(obj.fee_label),
    fee_paid_date: cleanIsoDate(obj.fee_paid_date),
    format: cleanStr(obj.format),
    deadline_date: cleanIsoDate(obj.deadline_date),
    deadline_label: cleanStr(obj.deadline_label),
    status,
    withdrawal_reason: cleanStr(obj.withdrawal_reason),
    draw_published: Boolean(obj.draw_published),
    change_type: cleanStr(obj.change_type) || 'new_event',
    update_summary: cleanStr(obj.update_summary) || 'Extracted tournament details from forwarded email.'
  };
}

function cleanStr(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length ? s : null;
}

function cleanIsoDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ============================================================================
// Deterministic Local Structured Parser (zero-key fallback)
// ============================================================================

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

function parseHumanDate(text) {
  if (!text) return null;
  // ISO format first
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) {
    return { iso: iso[1], label: formatIsoToNiceDate(iso[1]) };
  }
  // e.g. "Sun, Nov 22, 2026" or "Nov 22 2026" or "December 5, 2026"
  const m = text.match(/\b(?:(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)[a-z]*,?\s+)?(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})\b/i);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    const year = Number(m[3]);
    const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { iso: isoDate, label: formatIsoToNiceDate(isoDate) };
  }
  return null;
}

export function formatIsoToNiceDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function detectSourceLeague(from, subject, body) {
  const combined = `${from}\n${subject}\n${body}`;
  if (/bay area tennis team leagues?/i.test(combined) || /battl/i.test(combined)) {
    return 'Bay Area Tennis Team Leagues';
  }
  if (/\bUTR\b|universal tennis|universaltennis\.com/i.test(combined)) {
    return 'UTR';
  }
  if (/\bUSTA\b|playtennis\.usta\.com|norcal/i.test(combined)) {
    return 'USTA';
  }
  if (/\bAYSO\b/i.test(combined)) return 'AYSO';
  if (/\bUS Club Soccer\b/i.test(combined)) return 'US Club Soccer';
  if (/\bAAU\b/i.test(combined)) return 'AAU';
  const fromDomain = from.match(/@([a-z0-9.-]+)/i);
  if (fromDomain) {
    const base = fromDomain[1].split('.')[0];
    if (base && !['gmail', 'yahoo', 'icloud', 'outlook', 'hotmail', 'me'].includes(base.toLowerCase())) {
      return base.toUpperCase();
    }
  }
  return 'Tournament Email';
}

function matchExistingEventName(subject, body, existingEvents) {
  const haystack = `${subject}\n${body}`.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const ev of existingEvents) {
    const name = ev.event_name.toLowerCase();
    if (haystack.includes(name)) {
      return ev;
    }
    // Check significant tokens (length >= 4, excluding generic words)
    const stop = new Set(['usta', 'utr', 'tennis', 'team', 'teams', 'junior', 'level', 'session', 'league', 'leagues', 'bay', 'area', 'match', 'event']);
    const tokens = name.split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !stop.has(t));
    if (!tokens.length) continue;
    const hits = tokens.filter((t) => haystack.includes(t)).length;
    const ratio = hits / tokens.length;
    if (hits >= 2 || (tokens.length === 1 && hits === 1) || (hits >= 1 && ratio >= 0.6)) {
      if (ratio > bestScore) {
        bestScore = ratio;
        best = ev;
      }
    }
    // Check session number e.g. "Session 4320"
    const sessionMatch = name.match(/session\s+(\d+)/i);
    if (sessionMatch && haystack.includes(sessionMatch[1])) {
      return ev;
    }
  }
  return best;
}

function extractEventName(subject, body, league, matchedExisting) {
  if (matchedExisting) return matchedExisting.event_name;

  // Explicit labeled line in body: "Tournament:", "Event:", "League:"
  const labeled = body.match(/^(?:Tournament|Event|League|Program)\s*:\s*(.+)$/im);
  if (labeled) return labeled[1].trim().replace(/[.\s]+$/, '');

  // Clean subject prefixes like "Fwd:", "Re:", "Draw Posted:", "Time Change:", "Receipt:"
  let clean = subject
    .replace(/^(?:\s*(?:fwd?|re)\s*:\s*)+/i, '')
    .replace(/^(?:\[[^\]]+\]\s*)+/, '')
    .replace(/^(?:update|alert|notice|draw posted|schedule posted|time change|venue change|weather update|registration confirmed|payment receipt|withdrawal confirmed)\s*[-–:|]\s*/i, '')
    .trim();

  if (clean && clean.length >= 4) {
    // Strip trailing boilerplate like "- Registration Confirmed"
    clean = clean.replace(/\s*[-–|]\s*(?:registration confirmed|receipt|draw posted|schedule update|time change|match \d+).*$/i, '').trim();
    if (clean.length >= 4) return clean;
  }

  return `${league} Event`;
}

function extractLabeledLine(body, labels) {
  const pattern = new RegExp(`^(?:${labels.join('|')})\\s*:\\s*(.+)$`, 'im');
  const m = body.match(pattern);
  return m ? m[1].trim() : null;
}

export function localParseEmail({ from_address = '', subject = '', body = '', received_at = '' }, existingEvents = []) {
  const combined = `${subject}\n${body}`;
  const league = detectSourceLeague(from_address, subject, body);
  const matchedExisting = matchExistingEventName(subject, body, existingEvents);
  const eventName = extractEventName(subject, body, league, matchedExisting);

  // Division
  let division = extractLabeledLine(body, ['Division', 'Flight', 'Bracket', 'Group', 'Team Division']);
  if (!division) {
    const divMatch = combined.match(/\b(Girls'? \d+\s*(?:&|and)\s*under(?:\s+[A-Za-z]+)?|Boys'? \d+\s*(?:&|and)\s*under(?:\s+[A-Za-z]+)?|10(?:U|-and-under)\s*(?:Green|Orange|Red)(?:\s+division)?|Beginner Teams|Pearl Teams|Session\s+\d+)\b/i);
    if (divMatch) division = divMatch[1].trim();
  }
  if (!division && matchedExisting?.division) {
    division = matchedExisting.division;
  }

  // Fee
  let feeAmount = null;
  let feeLabel = null;
  let feePaidDate = null;
  const feeLine = extractLabeledLine(body, ['Entry Fee', 'Fee', 'Total Paid', 'Amount Paid', 'Payment', 'Total']);
  const feeSource = feeLine || combined;
  const dollarMatch = feeSource.match(/\$\s*(\d+(?:\.\d{2})?)/);
  if (dollarMatch) {
    feeAmount = Number(dollarMatch[1]);
    const paidDateMatch = feeSource.match(/paid\s+(?:on\s+)?([A-Za-z]+\s+\d{1,2},?\s+20\d{2}|20\d{2}-\d{2}-\d{2})/i);
    if (paidDateMatch) {
      const parsedPaid = parseHumanDate(paidDateMatch[1]);
      if (parsedPaid) feePaidDate = parsedPaid.iso;
      feeLabel = `$${feeAmount.toFixed(2)} paid ${parsedPaid ? parsedPaid.label.replace(/^[A-Za-z]+,\s*/, '') : paidDateMatch[1]}`;
    } else if (/paid|receipt|charged/i.test(combined)) {
      const recDate = parseHumanDate(received_at);
      if (recDate) {
        feePaidDate = recDate.iso;
        feeLabel = `$${feeAmount.toFixed(2)} paid ${recDate.label.replace(/^[A-Za-z]+,\s*/, '')}`;
      } else {
        feeLabel = `$${feeAmount.toFixed(2)} paid`;
      }
    } else {
      feeLabel = `$${feeAmount.toFixed(2)} entry`;
    }
  }

  // Venue & Venue Change
  let venue = extractLabeledLine(body, ['New Venue', 'Updated Venue', 'Venue', 'Location', 'Site', 'Courts', 'Facility']);
  let previousVenue = extractLabeledLine(body, ['Previous Venue', 'Old Venue', 'Originally at', 'Moved From']);
  let venueNote = null;

  const movedPattern = combined.match(/(?:venue|location|site|matches?)\s+(?:has been\s+|was\s+)?moved\s+from\s+([^.\n,]+?)\s+to\s+([^.\n,]+)/i);
  if (movedPattern) {
    previousVenue = previousVenue || movedPattern[1].trim();
    venue = venue || movedPattern[2].trim();
    venueNote = `Moved from ${previousVenue} to ${venue}`;
  } else {
    const movedToFrom = combined.match(/moved\s+to\s+([^.\n,]+?)\s+\(?(?:previously|from)\s+([^).\n,]+)\)?/i);
    if (movedToFrom) {
      venue = venue || movedToFrom[1].trim();
      previousVenue = previousVenue || movedToFrom[2].trim();
      venueNote = `Moved from ${previousVenue}`;
    }
  }
  if (venue && previousVenue && !venueNote) {
    venueNote = `Moved from ${previousVenue}`;
  }

  // Format
  let format = extractLabeledLine(body, ['Format', 'Match Format', 'Scoring Format', 'Scoring']);
  if (!format) {
    const fmtMatch = combined.match(/\b(up to \d+,?\s*no-?ad|short sets? to \d+[^.\n]*|best of 3[^.\n]*|8-game pro set[^.\n]*)\b/i);
    if (fmtMatch) format = fmtMatch[1].trim();
  }

  // Deadline
  let deadlineDate = null;
  let deadlineLabel = null;
  const deadlineLine = extractLabeledLine(body, ['Deadline', 'Registration Deadline', 'Check-in Deadline', 'Lineup Deadline', 'RSVP Deadline', 'Withdraw Deadline']);
  if (deadlineLine) {
    const parsedDl = parseHumanDate(deadlineLine);
    deadlineDate = parsedDl?.iso || null;
    deadlineLabel = deadlineLine;
  } else {
    const dlInline = combined.match(/(?:deadline|due by|check-in by|rsvp by|lineups? due)\s*:?\s*([^\n.]+)/i);
    if (dlInline) {
      const parsedDl = parseHumanDate(dlInline[1]);
      deadlineDate = parsedDl?.iso || null;
      deadlineLabel = dlInline[0].trim();
    }
  }

  // Date
  let eventDate = null;
  let dateLabel = null;
  const dateLine = extractLabeledLine(body, ['Match Date', 'Event Date', 'Date', 'Session Start', 'Start Date', 'Kickoff']);
  if (dateLine) {
    const parsed = parseHumanDate(dateLine);
    if (parsed) {
      eventDate = parsed.iso;
      dateLabel = /session/i.test(body) && /start/i.test(dateLine) ? `Session started ${parsed.label.replace(/^[A-Za-z]+,\s*/, '')}` : parsed.label;
    } else {
      dateLabel = dateLine;
    }
  } else {
    const sessionStartMatch = combined.match(/session\s+(?:started|starts|begins?)\s+(?:on\s+)?([A-Za-z]+\s+\d{1,2},?\s+20\d{2})/i);
    if (sessionStartMatch) {
      const parsed = parseHumanDate(sessionStartMatch[1]);
      if (parsed) {
        eventDate = parsed.iso;
        dateLabel = `Session started ${parsed.label.replace(/^[A-Za-z]+,\s*/, '')}`;
      }
    } else {
      // Find first date in body not immediately prefixed by "paid" or "deadline"
      const bodyWithoutDeadlines = body.replace(/^.*(?:deadline|paid).*$/gim, '');
      const parsed = parseHumanDate(bodyWithoutDeadlines) || parseHumanDate(subject);
      if (parsed) {
        eventDate = parsed.iso;
        dateLabel = parsed.label;
      }
    }
  }

  // Match time & notes
  let matchTime = extractLabeledLine(body, ['New Match Time', 'Updated Time', 'New Time', 'Match Time', 'First Match', 'Start Time', 'Time']);
  let matchTimeNote = null;

  if (/match time(?:s)?\s+(?:are\s+)?only\s+(?:available\s+)?in\s+the\s+usta\s+app/i.test(combined) || /check\s+the\s+usta\s+app\s+for\s+match\s+time/i.test(combined)) {
    matchTimeNote = 'Match time only in the USTA app';
  }
  if (/no\s+match\s+schedule\s+(?:has been\s+)?published\s+yet|schedule\s+(?:is\s+)?not\s+(?:yet\s+)?(?:published|posted)|draws?\s+not\s+(?:yet\s+)?posted/i.test(combined)) {
    matchTimeNote = 'No match schedule published yet';
  }

  // Check for weather / time move in prose if no explicit Time: line
  const movedTimeMatch = combined.match(/(?:moved|rescheduled|changed|pushed|delayed)\s+(?:from\s+(\d{1,2}:\d{2}\s*(?:am|pm))\s+)?to\s+(\d{1,2}:\d{2}\s*(?:am|pm))/i);
  if (movedTimeMatch && !matchTime) {
    matchTime = movedTimeMatch[2].toUpperCase();
  }
  if (!matchTime) {
    const onTimeMatch = combined.match(/courts?\s+(?:have\s+)?dried.*?(?:start(?:ing|ed)?\s+on\s+time)/i);
    if (onTimeMatch) {
      matchTime = 'Started on time (courts dried)';
    } else {
      const atTime = body.match(/\bat\s+(\d{1,2}:\d{2}\s*(?:am|pm))\b/i);
      if (atTime) matchTime = atTime[1].toUpperCase();
    }
  }

  // Status & Change Type detection
  const isWithdrawal = /\b(withdrew|withdrawn|withdrawal\s+confirm|medical\s+withdrawal|withdraw\s+due\s+to\s+(?:illness|sick|injury))\b/i.test(combined);
  const isDrawPosted = /\b(draw(?:s)?\s+(?:is|are|have been)?\s*posted|schedule\s+(?:is\s+)?(?:now\s+)?(?:live|published|posted)|match\s+#?1\s+scheduled|first\s+match\s+time)\b/i.test(combined);
  const isTimeChange = Boolean(movedTimeMatch) || /\b(time\s+change|rescheduled|delayed\s+by\s+wet\s+courts|rain\s+delay|weather\s+delay|courts?\s+(?:have\s+)?dried|new\s+(?:match\s+)?time|pushed\s+back)\b/i.test(combined);
  const isVenueChange = Boolean(previousVenue) || /\b(venue\s+(?:change|moved|update)|site\s+change|moved\s+from)\b/i.test(combined);
  const isAwaitingSchedule = /no\s+match\s+schedule\s+(?:has been\s+)?published\s+yet|schedule\s+(?:is\s+)?not\s+(?:yet\s+)?(?:published|posted)|schedule\s+tbd/i.test(combined);
  const isReceipt = /\b(payment\s+receipt|paid\s+\$|thank\s+you\s+for\s+your\s+payment|registration\s+payment)\b/i.test(combined);

  let status = 'registered';
  let drawPublished = false;
  let changeType = 'new_event';
  let withdrawalReason = null;
  let updateSummary = '';

  if (isWithdrawal) {
    status = 'withdrawn';
    changeType = 'withdrawal';
    const sickMatch = combined.match(/withdrew\s+(?:due\s+to\s+|because\s+of\s+)?([^.\n]+)/i);
    withdrawalReason = sickMatch ? `Withdrawn (${sickMatch[1].trim()}) — not a played match` : 'Withdrawn — not a played match';
    updateSummary = `${eventName}: marked as withdrawal (${withdrawalReason}).`;
  } else if (isVenueChange) {
    status = matchedExisting?.status || 'scheduled';
    drawPublished = Boolean(matchedExisting?.draw_published);
    changeType = 'venue_changed';
    updateSummary = venue && previousVenue
      ? `Venue moved from ${previousVenue} to ${venue}.`
      : `Venue updated to ${venue || 'new site'}.`;
  } else if (isTimeChange) {
    status = matchedExisting?.status === 'awaiting_schedule' ? 'draw_posted' : (matchedExisting?.status || 'scheduled');
    drawPublished = Boolean(matchedExisting?.draw_published || matchTime);
    changeType = 'time_changed';
    if (/courts?\s+(?:have\s+)?dried/i.test(combined)) {
      updateSummary = 'Courts dried — matches starting on time as originally scheduled.';
    } else if (/wet\s+courts|rain\s+delay/i.test(combined)) {
      updateSummary = `Matches delayed by wet courts to ${matchTime || 'later time'}.`;
    } else if (movedTimeMatch && movedTimeMatch[1]) {
      updateSummary = `Match time changed from ${movedTimeMatch[1].toUpperCase()} to ${movedTimeMatch[2].toUpperCase()}.`;
    } else {
      updateSummary = `Match time updated to ${matchTime || 'new time'}.`;
    }
  } else if (isDrawPosted) {
    status = 'draw_posted';
    drawPublished = true;
    changeType = 'draw_posted';
    const parts = [
      dateLabel,
      matchTime ? `at ${matchTime}` : null,
      venue ? `· ${venue}` : null
    ].filter(Boolean);
    updateSummary = `Draw / match schedule posted${parts.length ? `: ${parts.join(' ')}` : ''}.`;
  } else if (isAwaitingSchedule) {
    status = 'awaiting_schedule';
    drawPublished = false;
    changeType = matchedExisting ? 'update' : 'new_event';
    updateSummary = `${eventName} registered (${division || league}) — no match schedule published yet.`;
  } else if (isReceipt) {
    status = matchedExisting?.status || 'registered';
    drawPublished = Boolean(matchedExisting?.draw_published);
    changeType = 'payment_receipt';
    updateSummary = `Payment confirmed${feeLabel ? ` (${feeLabel})` : ''}.`;
  } else if (deadlineLabel && matchedExisting) {
    status = matchedExisting.status;
    drawPublished = Boolean(matchedExisting.draw_published);
    changeType = 'deadline_added';
    updateSummary = `Deadline added: ${deadlineLabel}.`;
  } else {
    status = matchTime ? 'scheduled' : 'registered';
    drawPublished = Boolean(matchTime);
    changeType = matchedExisting ? 'update' : 'new_event';
    updateSummary = `${eventName}${dateLabel ? ` on ${dateLabel}` : ''}${venue ? ` at ${venue}` : ''}.`;
  }

  return {
    event_name: eventName,
    source_league: league,
    division,
    event_date: eventDate,
    date_label: dateLabel,
    match_time: matchTime,
    match_time_note: matchTimeNote,
    venue,
    previous_venue: previousVenue,
    venue_note: venueNote,
    fee_amount: feeAmount,
    fee_label: feeLabel,
    fee_paid_date: feePaidDate,
    format,
    deadline_date: deadlineDate,
    deadline_label: deadlineLabel,
    status,
    withdrawal_reason: withdrawalReason,
    draw_published: drawPublished,
    change_type: changeType,
    update_summary: updateSummary
  };
}
