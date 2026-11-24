// ============================================================================
// Courtline V1 — Client Application
// Routes:
//   /                  Landing page
//   /inbox             Forward-an-email inbox (defaults to mia-yang)
//   /kid/:slug         Kid's unified schedule page
//   /kid/:slug/inbox   Kid-scoped forward-an-email inbox
// ============================================================================

const state = {
  meta: null,
  kids: [],
  activeLeagueFilter: 'all',
  showWithdrawals: true,
  expandedEvents: new Set(),
  inboxInputMode: 'fields', // 'fields' | 'eml'
  lastExtractionResult: null
};

const appRoot = document.getElementById('app-root');
const navAlertCount = document.getElementById('nav-alert-count');
const footerMeta = document.getElementById('footer-extractor-meta');

// Utilities
// ----------------------------------------------------------------------------

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(amount) {
  if (typeof amount !== 'number' || Number.isNaN(amount)) return '—';
  return `$${amount.toFixed(2)}`;
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function statusLabel(status) {
  const map = {
    draw_posted: 'Draw Posted',
    scheduled: 'Scheduled',
    awaiting_schedule: 'Awaiting Schedule',
    registered: 'Registered · Paid',
    withdrawn: 'Withdrawn · Sick',
    completed: 'Completed'
  };
  return map[status] || status;
}

function alertTypeLabel(type) {
  const map = {
    draw_posted: 'Draw Posted',
    time_changed: 'Time Change',
    venue_changed: 'Venue Moved',
    withdrawal: 'Withdrawal',
    deadline_added: 'Deadline'
  };
  return map[type] || 'Update';
}

function showToast(message) {
  const region = document.getElementById('toast-region');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 2600);
}

async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label);
  } catch {
    showToast(text);
  }
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// Navigation & Routing
// ----------------------------------------------------------------------------

function navigate(path) {
  if (window.location.pathname !== path) {
    window.history.pushState({}, '', path);
  }
  renderRoute();
}

function parseRoute(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/') return { view: 'landing' };
  if (clean === '/inbox') return { view: 'inbox', slug: 'mia-yang' };
  const inboxMatch = clean.match(/^\/kid\/([^/]+)\/inbox$/);
  if (inboxMatch) return { view: 'inbox', slug: decodeURIComponent(inboxMatch[1]) };
  const kidMatch = clean.match(/^\/kid\/([^/]+)$/);
  if (kidMatch) return { view: 'schedule', slug: decodeURIComponent(kidMatch[1]) };
  return { view: 'landing' };
}

function updateNavActive(route) {
  const landingLink = document.getElementById('nav-landing');
  const scheduleLink = document.getElementById('nav-schedule');
  const inboxLink = document.getElementById('nav-inbox');

  landingLink.classList.toggle('is-active', route.view === 'landing');
  scheduleLink.classList.toggle('is-active', route.view === 'schedule');
  inboxLink.classList.toggle('is-active', route.view === 'inbox');

  const mia = state.kids.find((k) => k.slug === 'mia-yang') || state.kids[0];
  if (mia) {
    scheduleLink.setAttribute('href', `/kid/${encodeURIComponent(mia.slug)}`);
    inboxLink.setAttribute('href', `/kid/${encodeURIComponent(route.slug || mia.slug)}/inbox`);
    const unread = Number(mia.unread_alert_count || 0);
    if (unread > 0) {
      navAlertCount.textContent = String(unread);
      navAlertCount.hidden = false;
    } else {
      navAlertCount.hidden = true;
    }
  }
}

async function refreshGlobalState() {
  const [meta, kidsRes] = await Promise.all([
    state.meta ? Promise.resolve(state.meta) : apiFetch('/api/meta'),
    apiFetch('/api/kids')
  ]);
  state.meta = meta;
  state.kids = kidsRes.kids || [];
  if (footerMeta && state.meta?.extractor) {
    footerMeta.textContent = `Extractor: ${state.meta.extractor.label}`;
  }
}

async function renderRoute() {
  const route = parseRoute(window.location.pathname);
  try {
    await refreshGlobalState();
    updateNavActive(route);

    if (route.view === 'landing') {
      document.title = 'Courtline — Youth Sports Tournament Schedule from Your Inbox';
      renderLanding();
    } else if (route.view === 'schedule') {
      await renderSchedule(route.slug);
    } else if (route.view === 'inbox') {
      await renderInbox(route.slug);
    }
  } catch (err) {
    appRoot.innerHTML = `
      <div class="container">
        <div class="panel">
          <h1 class="page-title">Something went wrong</h1>
          <p class="panel-sub">${esc(err.message)}</p>
          <a href="/" class="btn btn-primary" data-link>Back to overview</a>
        </div>
      </div>
    `;
  }
}

// ============================================================================
// VIEW 1: Landing Page (/)
// ============================================================================

function renderLanding() {
  const mia = state.kids.find((k) => k.slug === 'mia-yang') || state.kids[0];
  const miaUrl = mia ? `/kid/${encodeURIComponent(mia.slug)}` : '/kid/mia-yang';
  const inboxUrl = mia ? `/kid/${encodeURIComponent(mia.slug)}/inbox` : '/inbox';

  const kidChips = state.kids
    .map(
      (k) => `
      <a href="/kid/${encodeURIComponent(k.slug)}" class="kid-chip-link" data-link>
        <span>${esc(k.name)}</span>
        <span class="mono" style="font-size:11.5px;color:var(--ink-muted)">${esc(k.division)}</span>
      </a>`
    )
    .join('');

  appRoot.innerHTML = `
    <section class="container">
      <div class="hero-grid">
        <div>
          <p class="hero-kicker">Email is the integration · Weekend V1</p>
          <h1 class="hero-title">Forward tournament emails. Get one schedule page per kid.</h1>
          <p class="hero-subtitle">
            USTA confirmations, UTR team rosters, night-before venue moves, wet-court rain delays, and league receipts—all buried in different threads. Forward them to one address and get a single, shareable schedule page with automatic draw and time-change alerts.
          </p>
          <div class="hero-actions">
            <a href="${miaUrl}" class="btn btn-primary" data-link id="cta-open-mia">Open Mia Yang’s Schedule</a>
            <a href="${inboxUrl}" class="btn btn-secondary" data-link id="cta-try-inbox">Try Forward-an-Email Inbox</a>
          </div>
          <div class="hero-principles">
            <span>No accounts or passwords</span>
            <span>No app to install</span>
            <span>No scraping USTA or UTR logins</span>
          </div>
        </div>

        <aside class="dispatch-card" aria-label="Example forwarded email extraction">
          <div class="dispatch-top">
            <span class="dispatch-label">Forwarded Email → Live Alert</span>
            <span class="dispatch-address">${esc(mia?.inbox_email || 'mia-yang@inbox.courtline.app')}</span>
          </div>
          <div class="dispatch-body">
            <div class="dispatch-email-excerpt">
              <div class="dispatch-email-subject">Fwd: VENUE MOVE — Chance Through Sport Level 7</div>
              <div>“Tomorrow’s Girls’ 12 &amp; under matches have moved from West Valley College to Mission College Santa Clara. Format up to 4, no-ad. Check the USTA app for match time.”</div>
            </div>
            <div class="dispatch-arrow">LLM extracts &amp; diffs against earlier emails</div>
            <div class="dispatch-extracted">
              <div class="dispatch-alert-head">Venue Changed Alert · Sat Night Before</div>
              <p class="dispatch-diff">
                <s>West Valley College</s> → <strong>Mission College Santa Clara</strong>
              </p>
              <dl class="dispatch-fields">
                <div>
                  <dt>League &amp; Division</dt>
                  <dd>USTA · Girls’ 12 &amp; under</dd>
                </div>
                <div>
                  <dt>Date &amp; Fee</dt>
                  <dd>Sun Nov 22, 2026 · $75.13</dd>
                </div>
                <div>
                  <dt>Format</dt>
                  <dd>Up to 4, no-ad</dd>
                </div>
                <div>
                  <dt>Match Time</dt>
                  <dd>USTA app only</dd>
                </div>
              </dl>
            </div>
          </div>
        </aside>
      </div>

      <div class="section-rule">
        <h2 class="section-heading">How one forwarded email keeps the whole family synced</h2>
        <div class="steps-grid">
          <div class="step-item">
            <div class="step-num">01 / FORWARD</div>
            <h3 class="step-title">Forward from Gmail or Apple Mail</h3>
            <p class="step-desc">Each kid gets a dedicated forwarding address. Send registration receipts, draw notifications, venue changes, rain delays, or withdrawal confirmations straight there.</p>
          </div>
          <div class="step-item">
            <div class="step-num">02 / EXTRACT &amp; DIFF</div>
            <h3 class="step-title">Structured fields + change detection</h3>
            <p class="step-desc">An LLM extracts event name, date, venue, division, fee, source league, format, and withdrawal status—then merges updates into existing events instead of duplicating them.</p>
          </div>
          <div class="step-item">
            <div class="step-num">03 / SCHEDULE &amp; ALERTS</div>
            <h3 class="step-title">One clean page per kid</h3>
            <p class="step-desc">Share one URL with grandparents, co-parents, or carpool drivers. Draws posted, match times shifted, or venues moved trigger clear alerts at the top of the schedule.</p>
          </div>
        </div>
      </div>

      <div class="create-kid-band">
        <div>
          <h2>Start a schedule page for another kid</h2>
          <p>Zero signup required. Enter a name and division to generate a private schedule URL and forwarding inbox immediately.</p>
          ${state.kids.length ? `<div class="existing-kids-list"><span class="existing-kids-label">Active pages:</span>${kidChips}</div>` : ''}
        </div>
        <form id="create-kid-form" class="inline-kid-form">
          <div class="field">
            <label for="new-kid-name">Kid’s name</label>
            <input id="new-kid-name" class="input" type="text" placeholder="e.g. Leo Chen" required />
          </div>
          <div class="field">
            <label for="new-kid-division">Division / Level</label>
            <input id="new-kid-division" class="input" type="text" placeholder="e.g. 12U Orange Ball" required />
          </div>
          <button type="submit" class="btn btn-primary" id="btn-create-kid">Create Page</button>
        </form>
      </div>
    </section>
  `;

  document.getElementById('create-kid-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('new-kid-name');
    const divInput = document.getElementById('new-kid-division');
    const btn = document.getElementById('btn-create-kid');
    btn.disabled = true;
    try {
      const { kid } = await apiFetch('/api/kids', {
        method: 'POST',
        body: JSON.stringify({ name: nameInput.value, division: divInput.value })
      });
      showToast(`Created schedule page for ${kid.name}`);
      navigate(`/kid/${encodeURIComponent(kid.slug)}`);
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
    }
  });
}

// ============================================================================
// VIEW 2: Kid Schedule Page (/kid/:slug)
// ============================================================================

async function renderSchedule(slug) {
  const data = await apiFetch(`/api/kids/${encodeURIComponent(slug)}/schedule`);
  const { kid, summary, alerts, events } = data;
  document.title = `${kid.name} — Tournament Schedule · Courtline`;

  // Collect distinct leagues for filter toolbar
  const leagues = Array.from(new Set(events.map((e) => e.source_league).filter(Boolean)));
  if (state.activeLeagueFilter !== 'all' && !leagues.includes(state.activeLeagueFilter)) {
    state.activeLeagueFilter = 'all';
  }

  const filteredEvents = events.filter((ev) => {
    if (!state.showWithdrawals && ev.status === 'withdrawn') return false;
    if (state.activeLeagueFilter !== 'all' && ev.source_league !== state.activeLeagueFilter) return false;
    return true;
  });

  const unreadAlerts = alerts.filter((a) => !a.is_read);
  const kidSwitcherOptions = state.kids
    .map(
      (k) => `<option value="${esc(k.slug)}" ${k.slug === kid.slug ? 'selected' : ''}>${esc(k.name)} (${esc(k.division)})</option>`
    )
    .join('');

  appRoot.innerHTML = `
    <section class="container">
      <header class="page-header">
        <div>
          <p class="page-eyebrow">Player Schedule · Unified Across Leagues</p>
          <h1 class="page-title">${esc(kid.name)}</h1>
          <div class="page-meta-row">
            <span class="division-tag">${esc(kid.division)}</span>
            <button type="button" class="inbox-copy-chip" id="btn-copy-inbox" data-copy="${esc(kid.inbox_email)}" title="Copy forwarding email address">
              <span>${esc(kid.inbox_email)}</span>
              <span style="font-family:var(--font-sans);font-size:11px;opacity:0.75">Copy</span>
            </button>
            ${
              state.kids.length > 1
                ? `<select id="kid-switcher" class="select" style="width:auto;padding:5px 10px;font-size:13px" aria-label="Switch kid">${kidSwitcherOptions}</select>`
                : ''
            }
          </div>
        </div>
        <div class="page-actions">
          <a href="/kid/${encodeURIComponent(kid.slug)}/inbox" class="btn btn-primary" data-link id="btn-forward-email">Forward Email</a>
          <a href="/api/kids/${encodeURIComponent(kid.slug)}/calendar.ics" class="btn btn-secondary" id="btn-export-ics">Export .ics</a>
          <button type="button" class="btn btn-secondary" id="btn-copy-share">Share Link</button>
          ${kid.slug === 'mia-yang' ? `<button type="button" class="btn btn-ghost btn-sm" id="btn-reset-demo" title="Restore Mia Yang's original 4 seeded events">Reset Demo</button>` : ''}
        </div>
      </header>

      <div class="summary-strip" aria-label="Schedule summary">
        <div class="summary-cell">
          <div class="summary-label">Active Sessions</div>
          <div class="summary-value">${summary.active_events}</div>
          <div class="summary-sub">${summary.total_events} total tracked</div>
        </div>
        <div class="summary-cell">
          <div class="summary-label">Awaiting Draw</div>
          <div class="summary-value">${summary.awaiting_schedule_count}</div>
          <div class="summary-sub">Watching inbox for schedules</div>
        </div>
        <div class="summary-cell">
          <div class="summary-label">Played Matches</div>
          <div class="summary-value">${summary.played_matches_count}</div>
          <div class="summary-sub">${summary.withdrawn_count} withdrawal${summary.withdrawn_count === 1 ? '' : 's'} excluded</div>
        </div>
        <div class="summary-cell">
          <div class="summary-label">Fees Tracked</div>
          <div class="summary-value">${formatMoney(summary.total_fees)}</div>
          <div class="summary-sub">Across entries &amp; leagues</div>
        </div>
      </div>

      ${
        alerts.length
          ? renderAlertsPanel(alerts, unreadAlerts, kid.slug)
          : ''
      }

      <div class="schedule-toolbar">
        <div class="filter-pills" role="group" aria-label="Filter by league">
          <button type="button" class="filter-pill ${state.activeLeagueFilter === 'all' ? 'is-active' : ''}" data-league="all">
            All Leagues (${events.length})
          </button>
          ${leagues
            .map(
              (lg) => `
              <button type="button" class="filter-pill ${state.activeLeagueFilter === lg ? 'is-active' : ''}" data-league="${esc(lg)}">
                ${esc(lg)}
              </button>`
            )
            .join('')}
        </div>

        <label class="toggle-label" for="toggle-withdrawals">
          <input type="checkbox" id="toggle-withdrawals" ${state.showWithdrawals ? 'checked' : ''} />
          <span>Show withdrawals (${summary.withdrawn_count})</span>
        </label>
      </div>

      <div class="events-stack" id="events-list">
        ${
          filteredEvents.length
            ? filteredEvents.map((ev) => renderEventCard(ev, kid)).join('')
            : `<div class="panel"><p class="panel-sub" style="margin:0">No events match the current filter. Forward a tournament email to <span class="mono">${esc(kid.inbox_email)}</span> to add one.</p></div>`
        }
      </div>
    </section>
  `;

  // Event listeners
  document.getElementById('btn-copy-inbox')?.addEventListener('click', (e) => {
    copyText(e.currentTarget.dataset.copy, 'Forwarding address copied');
  });

  document.getElementById('btn-copy-share')?.addEventListener('click', () => {
    copyText(window.location.href, 'Schedule link copied');
  });

  document.getElementById('kid-switcher')?.addEventListener('change', (e) => {
    navigate(`/kid/${encodeURIComponent(e.target.value)}`);
  });

  document.getElementById('btn-reset-demo')?.addEventListener('click', async () => {
    await apiFetch('/api/demo/reset', { method: 'POST' });
    state.lastExtractionResult = null;
    showToast('Reset to Mia Yang’s seeded schedule');
    renderSchedule('mia-yang');
    refreshGlobalState().then(() => updateNavActive({ view: 'schedule', slug: 'mia-yang' }));
  });

  document.getElementById('btn-mark-all-read')?.addEventListener('click', async () => {
    await apiFetch(`/api/kids/${encodeURIComponent(kid.slug)}/alerts/read-all`, { method: 'POST' });
    showToast('All alerts marked read');
    renderRoute();
  });

  document.querySelectorAll('[data-dismiss-alert]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.dismissAlert;
      const nextRead = btn.dataset.nextRead !== 'false';
      await apiFetch(`/api/alerts/${id}/read`, {
        method: 'POST',
        body: JSON.stringify({ is_read: nextRead })
      });
      renderRoute();
    });
  });

  document.querySelectorAll('[data-league]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeLeagueFilter = btn.dataset.league;
      renderSchedule(kid.slug);
    });
  });

  document.getElementById('toggle-withdrawals')?.addEventListener('change', (e) => {
    state.showWithdrawals = e.target.checked;
    renderSchedule(kid.slug);
  });

  document.querySelectorAll('[data-toggle-event]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.toggleEvent);
      if (state.expandedEvents.has(id)) {
        state.expandedEvents.delete(id);
      } else {
        state.expandedEvents.add(id);
      }
      renderSchedule(kid.slug);
    });
  });
}

function renderAlertsPanel(alerts, unreadAlerts) {
  const visibleAlerts = unreadAlerts.length ? unreadAlerts : alerts.slice(0, 3);
  const heading = unreadAlerts.length
    ? `${unreadAlerts.length} Active Alert${unreadAlerts.length === 1 ? '' : 's'} — Draws, Venue Moves & Time Changes`
    : 'Recent Schedule Alerts (All Read)';

  return `
    <section class="alerts-section" aria-label="Schedule alerts">
      <div class="alerts-header">
        <h2 class="alerts-title">${esc(heading)}</h2>
        ${
          unreadAlerts.length
            ? `<button type="button" class="btn btn-ghost btn-sm" id="btn-mark-all-read">Mark all read</button>`
            : ''
        }
      </div>
      <div class="alerts-list">
        ${visibleAlerts
          .map(
            (al) => `
            <article class="alert-row ${al.is_read ? 'is-read' : ''}">
              <div>
                <h3 class="alert-heading">
                  <span class="alert-type-pill alert-type-${esc(al.alert_type)}">${esc(alertTypeLabel(al.alert_type))}</span>
                  ${esc(al.title)}
                </h3>
                <p class="alert-msg">${esc(al.message)}</p>
                ${
                  al.previous_value || al.new_value
                    ? `<div class="alert-diff-line">
                        ${al.previous_value ? `<span class="diff-old">${esc(al.previous_value)}</span><span>→</span>` : ''}
                        ${al.new_value ? `<span class="diff-new">${esc(al.new_value)}</span>` : ''}
                        <span style="color:var(--ink-muted);margin-left:4px">· ${esc(formatTimestamp(al.created_at))}</span>
                      </div>`
                    : ''
                }
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                data-dismiss-alert="${al.id}"
                data-next-read="${al.is_read ? 'false' : 'true'}"
              >
                ${al.is_read ? 'Unread' : 'Dismiss'}
              </button>
            </article>`
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderEventCard(ev, kid) {
  const isWithdrawn = ev.status === 'withdrawn';
  const isExpanded = state.expandedEvents.has(ev.id);

  // Determine callout banner
  let calloutHtml = '';
  if (isWithdrawn) {
    calloutHtml = `
      <div class="event-callout callout-withdrawn">
        <span><strong>Withdrawal (not a played match):</strong> ${esc(ev.withdrawal_reason || 'Withdrew prior to play.')}</span>
      </div>`;
  } else if (!ev.draw_published) {
    calloutHtml = `
      <div class="event-callout callout-pending">
        <span><strong>Schedule pending:</strong> ${esc(ev.match_time_note || 'No match schedule published yet.')} Forward the draw email when it arrives.</span>
        <a href="/kid/${encodeURIComponent(kid.slug)}/inbox" class="btn btn-ghost btn-sm" data-link style="color:inherit;text-decoration:underline">Forward draw email</a>
      </div>`;
  } else if (ev.status === 'draw_posted') {
    calloutHtml = `
      <div class="event-callout callout-draw">
        <span><strong>Draw published:</strong> ${esc([ev.date_label, ev.match_time, ev.venue].filter(Boolean).join(' · '))}</span>
      </div>`;
  }

  // Match time display
  const matchTimeMain = ev.match_time || (ev.draw_published ? 'See league app' : 'Not published yet');
  const matchTimeSub = ev.match_time_note
    ? `<div class="fact-sub ${/usta app/i.test(ev.match_time_note) ? 'is-app-note' : ''}">${esc(ev.match_time_note)}</div>`
    : '';

  // Venue display
  const venueMain = ev.venue || 'TBD';
  let venueSub = '';
  if (ev.previous_venue) {
    venueSub = `<div class="fact-sub is-change">${esc(ev.venue_note || `Moved from ${ev.previous_venue}`)}</div>`;
  } else if (ev.venue_note) {
    venueSub = `<div class="fact-sub">${esc(ev.venue_note)}</div>`;
  }

  // Division display (highlight playing up if different from kid's primary 10U division)
  const playingUp = ev.division && /12\s*&|12u/i.test(ev.division) && /10/i.test(kid.division);
  const divisionSub = playingUp ? `<div class="fact-sub">Playing up from ${esc(kid.division)}</div>` : '';

  // Fee display
  const feeMain = ev.fee_label || (ev.fee_amount != null ? formatMoney(ev.fee_amount) : 'Not listed in email');

  // Format / Deadline display
  const formatMain = ev.format || (ev.deadline_label ? ev.deadline_label : 'Standard / TBD');
  const deadlineSub = ev.format && ev.deadline_label
    ? `<div class="fact-sub is-change">Deadline: ${esc(ev.deadline_label)}</div>`
    : '';

  const latestNote = ev.schedule_notes?.length ? ev.schedule_notes[ev.schedule_notes.length - 1] : null;
  const emailCount = ev.emails?.length || 0;

  return `
    <article class="event-card ${isWithdrawn ? 'is-withdrawn' : ''}" id="event-card-${ev.id}">
      <div class="event-card-top">
        <div>
          <div class="event-league">${esc(ev.source_league)}</div>
          <h2 class="event-title">${esc(ev.event_name)}</h2>
        </div>
        <span class="status-badge status-${esc(ev.status)}">${esc(statusLabel(ev.status))}</span>
      </div>

      ${calloutHtml}

      <div class="facts-grid">
        <div>
          <div class="fact-label">Date / Session</div>
          <div class="fact-value ${ev.date_label ? '' : 'is-muted'}">${esc(ev.date_label || ev.event_date || 'Date TBD')}</div>
        </div>
        <div>
          <div class="fact-label">Match Time / Draw</div>
          <div class="fact-value ${ev.match_time ? '' : 'is-muted'}">${esc(matchTimeMain)}</div>
          ${matchTimeSub}
        </div>
        <div>
          <div class="fact-label">Venue</div>
          <div class="fact-value ${ev.venue ? '' : 'is-muted'}">${esc(venueMain)}</div>
          ${venueSub}
        </div>
        <div>
          <div class="fact-label">Division</div>
          <div class="fact-value ${ev.division ? '' : 'is-muted'}">${esc(ev.division || '—')}</div>
          ${divisionSub}
        </div>
        <div>
          <div class="fact-label">Entry / Fee</div>
          <div class="fact-value mono ${ev.fee_amount != null ? '' : 'is-muted'}" style="font-size:13.5px">${esc(feeMain)}</div>
        </div>
        <div>
          <div class="fact-label">${ev.format ? 'Format' : ev.deadline_label ? 'Deadline' : 'Format / Deadline'}</div>
          <div class="fact-value ${ev.format || ev.deadline_label ? '' : 'is-muted'}">${esc(formatMain)}</div>
          ${deadlineSub}
        </div>
      </div>

      <div class="event-footer">
        <p class="event-latest-note">
          ${latestNote ? `<strong>Latest update:</strong> ${esc(latestNote.text)}` : 'Extracted from forwarded email.'}
        </p>
        <button type="button" class="btn btn-ghost btn-sm" data-toggle-event="${ev.id}" aria-expanded="${isExpanded}">
          ${isExpanded ? 'Hide timeline & emails' : `${emailCount} forwarded email${emailCount === 1 ? '' : 's'} · View trail`}
        </button>
      </div>

      ${isExpanded ? renderEventDrawer(ev) : ''}
    </article>
  `;
}

function renderEventDrawer(ev) {
  const timelineHtml = (ev.schedule_notes || [])
    .map(
      (n) => `
      <li class="timeline-item">
        <span class="timeline-date">${esc(formatTimestamp(n.at))}</span>
        <span class="timeline-text">${esc(n.text)}</span>
      </li>`
    )
    .join('');

  const emailsHtml = (ev.emails || [])
    .map(
      (em) => `
      <div class="source-email-item">
        <div class="source-email-meta">${esc(em.from_address)} · ${esc(formatTimestamp(em.received_at))} · <span class="mono">${esc(em.extraction_provider)}</span></div>
        <div class="source-email-subject">${esc(em.subject)}</div>
        <pre class="source-email-body">${esc(em.body)}</pre>
      </div>`
    )
    .join('');

  return `
    <div class="event-drawer">
      <div class="fact-label" style="margin-bottom:8px">Chronological Email Timeline</div>
      <ul class="timeline-list">${timelineHtml || '<li class="timeline-item"><span>No timeline entries yet.</span></li>'}</ul>
      <div class="fact-label" style="margin-bottom:6px">Source Forwarded Emails</div>
      ${emailsHtml || '<p class="panel-sub">No source emails linked.</p>'}
    </div>
  `;
}

// ============================================================================
// VIEW 3: Forward-an-Email Inbox (/inbox and /kid/:slug/inbox)
// ============================================================================

async function renderInbox(slug) {
  const data = await apiFetch(`/api/kids/${encodeURIComponent(slug)}/schedule`);
  const { kid, emails } = data;
  const samples = state.meta?.sample_emails || [];
  document.title = `Forward Email — ${kid.name} · Courtline`;

  const kidOptions = state.kids
    .map((k) => `<option value="${esc(k.slug)}" ${k.slug === kid.slug ? 'selected' : ''}>${esc(k.name)} — ${esc(k.inbox_email)}</option>`)
    .join('');

  const sampleButtons = samples
    .map(
      (s) => `
      <button type="button" class="sample-btn" data-sample-id="${esc(s.id)}">
        <span class="sample-btn-title">${esc(s.label)}</span>
        <span class="sample-btn-desc">${esc(s.description)}</span>
      </button>`
    )
    .join('');

  const webhookCurl = `curl -X POST ${window.location.origin}/api/inbound-email \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "${kid.inbox_email}",
    "from": "notifications@universaltennis.com",
    "subject": "Draw Posted — UTR Sunny Youngs",
    "text": "Match Date: Sun Nov 29, 2026\\nMatch Time: 10:30 AM\\nVenue: Cupertino Sports Center"
  }'`;

  appRoot.innerHTML = `
    <section class="container">
      <header class="page-header">
        <div>
          <p class="page-eyebrow">Forward-an-Email Inbox</p>
          <h1 class="page-title">Send tournament emails for ${esc(kid.name)}</h1>
          <div class="page-meta-row">
            <span>Forward from Gmail/Apple Mail to the address below, or paste an email right here to test extraction &amp; alerts.</span>
          </div>
        </div>
        <div class="page-actions">
          <a href="/kid/${encodeURIComponent(kid.slug)}" class="btn btn-secondary" data-link id="btn-back-schedule">View ${esc(kid.name)}’s Schedule →</a>
        </div>
      </header>

      <div class="inbox-layout">
        <div class="panel">
          <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px">
            <h2 class="panel-title" style="margin:0">Forward or Paste an Email</h2>
            ${
              state.kids.length > 1
                ? `<select id="inbox-kid-select" class="select" style="width:auto;padding:6px 10px;font-size:13px">${kidOptions}</select>`
                : ''
            }
          </div>

          <div class="forward-address-box">
            <div>
              <div style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--pine)">Kid’s Forwarding Address</div>
              <div class="forward-address-value">${esc(kid.inbox_email)}</div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-forward-addr">Copy Address</button>
          </div>

          <div class="sample-strip">
            <div class="sample-strip-label">One-click realistic test emails (click to fill)</div>
            <div class="sample-grid">${sampleButtons}</div>
          </div>

          <div class="mode-tabs" role="tablist">
            <button type="button" class="mode-tab ${state.inboxInputMode === 'fields' ? 'is-active' : ''}" data-mode="fields">Email Fields</button>
            <button type="button" class="mode-tab ${state.inboxInputMode === 'eml' ? 'is-active' : ''}" data-mode="eml">Raw .eml Paste</button>
          </div>

          <form id="forward-email-form" class="form-stack">
            ${
              state.inboxInputMode === 'fields'
                ? `
                <div class="form-row-2">
                  <div class="field">
                    <label for="email-from">From</label>
                    <input id="email-from" class="input" type="text" placeholder="notifications@universaltennis.com" value="notifications@universaltennis.com" required />
                  </div>
                  <div class="field">
                    <label for="email-subject">Subject</label>
                    <input id="email-subject" class="input" type="text" placeholder="Fwd: Draw Posted — UTR Sunny Youngs" required />
                  </div>
                </div>
                <div class="field">
                  <label for="email-body">Forwarded Email Body</label>
                  <textarea id="email-body" class="textarea" placeholder="Paste the tournament confirmation, draw posting, venue move, weather delay, or payment receipt here..." required></textarea>
                </div>`
                : `
                <div class="field">
                  <label for="email-raw-eml">Raw .eml Source (headers + body)</label>
                  <textarea id="email-raw-eml" class="textarea mono" style="font-size:12.5px" placeholder="From: director@tournament.org&#10;Subject: Fwd: Time Change&#10;Date: Sun, 29 Nov 2026 08:00:00 -0800&#10;&#10;Match moved from 10:30 AM to 1:15 PM..." required></textarea>
                </div>`
            }
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <span style="font-size:12.5px;color:var(--ink-muted)">Mode: <span class="mono">${esc(state.meta?.extractor?.provider || 'local-parser')}</span></span>
              <button type="submit" class="btn btn-primary" id="btn-submit-email">Extract &amp; Update Schedule</button>
            </div>
          </form>

          ${state.lastExtractionResult ? renderExtractionResult(state.lastExtractionResult, kid.slug) : ''}

          <div class="webhook-box">
            <div class="fact-label">Real Inbound Email Webhook (Postmark / Resend / Mailgun / Cloudflare)</div>
            <p class="panel-sub" style="margin:4px 0 8px">Point your inbound email router at <span class="mono">POST /api/inbound-email</span>. Emails addressed to <span class="mono">${esc(kid.inbox_email)}</span> route straight to ${esc(kid.name)}.</p>
            <pre class="webhook-code">${esc(webhookCurl)}</pre>
          </div>
        </div>

        <aside class="panel">
          <h2 class="panel-title">Received Emails (${emails.length})</h2>
          <p class="panel-sub">Every email forwarded to ${esc(kid.name)}’s inbox, with the structured fields extracted from it.</p>
          <div class="inbox-history-list">
            ${
              emails.length
                ? emails
                    .map(
                      (em) => `
                  <details class="history-item">
                    <summary>
                      <div class="history-top">
                        <span class="history-subject">${esc(em.subject)}</span>
                        <span class="history-date">${esc(formatTimestamp(em.received_at))}</span>
                      </div>
                      <div class="history-from">${esc(em.from_address)} · <span class="mono">${esc(em.extraction_provider)}</span></div>
                    </summary>
                    <div class="history-expanded">
                      <div class="fact-label" style="margin-bottom:4px">Email Body</div>
                      <pre class="source-email-body">${esc(em.body)}</pre>
                      <div class="fact-label" style="margin:10px 0 4px">Extracted Fields</div>
                      <pre class="json-preview">${esc(JSON.stringify(em.extracted, null, 2))}</pre>
                    </div>
                  </details>`
                    )
                    .join('')
                : '<p class="panel-sub">No emails received yet. Forward or paste one on the left.</p>'
            }
          </div>
        </aside>
      </div>
    </section>
  `;

  // Wire up handlers
  document.getElementById('btn-copy-forward-addr')?.addEventListener('click', () => {
    copyText(kid.inbox_email, 'Forwarding address copied');
  });

  document.getElementById('inbox-kid-select')?.addEventListener('change', (e) => {
    state.lastExtractionResult = null;
    navigate(`/kid/${encodeURIComponent(e.target.value)}/inbox`);
  });

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.inboxInputMode = btn.dataset.mode;
      renderInbox(kid.slug);
    });
  });

  document.querySelectorAll('[data-sample-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sample = samples.find((s) => s.id === btn.dataset.sampleId);
      if (!sample) return;
      if (state.inboxInputMode !== 'fields') {
        state.inboxInputMode = 'fields';
        renderInbox(kid.slug).then(() => fillSampleFields(sample));
      } else {
        fillSampleFields(sample);
      }
      showToast(`Loaded sample: ${sample.label}`);
    });
  });

  document.getElementById('forward-email-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('btn-submit-email');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Extracting…';

    try {
      let payload;
      if (state.inboxInputMode === 'eml') {
        payload = { raw_eml: document.getElementById('email-raw-eml').value };
      } else {
        payload = {
          from_address: document.getElementById('email-from').value,
          subject: document.getElementById('email-subject').value,
          body: document.getElementById('email-body').value
        };
      }

      const result = await apiFetch(`/api/kids/${encodeURIComponent(kid.slug)}/emails`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      state.lastExtractionResult = result;
      showToast(
        result.alerts?.length
          ? `Schedule updated · ${result.alerts.length} new alert${result.alerts.length === 1 ? '' : 's'} triggered`
          : `Schedule ${result.action}: ${result.event.event_name}`
      );
      await refreshGlobalState();
      updateNavActive({ view: 'inbox', slug: kid.slug });
      await renderInbox(kid.slug);
    } catch (err) {
      showToast(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Extract & Update Schedule';
    }
  });
}

function fillSampleFields(sample) {
  const fromEl = document.getElementById('email-from');
  const subjEl = document.getElementById('email-subject');
  const bodyEl = document.getElementById('email-body');
  if (fromEl) fromEl.value = sample.from_address;
  if (subjEl) subjEl.value = sample.subject;
  if (bodyEl) bodyEl.value = sample.body;
}

function renderExtractionResult(result, slug) {
  const alertsHtml = (result.alerts || [])
    .map(
      (a) => `<div style="margin-top:6px;font-size:13px;color:var(--clay)"><strong>Alert triggered (${esc(alertTypeLabel(a.alert_type))}):</strong> ${esc(a.title)} — ${esc(a.message)}</div>`
    )
    .join('');

  return `
    <div class="extraction-result" id="extraction-result-card">
      <div class="extraction-result-head">
        <h3 class="extraction-result-title">
          ${result.action === 'created' ? 'New event added' : 'Matched & updated existing event'}: ${esc(result.event?.event_name)}
        </h3>
        <a href="/kid/${encodeURIComponent(slug)}" class="btn btn-primary btn-sm" data-link>See on Schedule →</a>
      </div>
      <div style="font-size:13px;color:var(--ink-secondary)">
        Extracted via <span class="mono">${esc(result.provider)}</span> · Status: <strong>${esc(statusLabel(result.event?.status))}</strong>
      </div>
      ${alertsHtml}
      <pre class="json-preview">${esc(JSON.stringify(result.extracted, null, 2))}</pre>
    </div>
  `;
}

// Global Click & Popstate Delegation
// ----------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link]');
  if (!link) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  navigate(link.getAttribute('href'));
});

window.addEventListener('popstate', () => {
  renderRoute();
});

renderRoute();
