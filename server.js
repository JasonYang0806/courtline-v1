import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKid,
  getDb,
  getKidByInboxEmail,
  getKidBySlug,
  getKidScheduleData,
  INBOX_DOMAIN,
  listKids,
  markAlertRead,
  markAllAlertsRead,
  resetDatabase
} from './src/db.js';
import { getActiveExtractorInfo } from './src/extractor.js';
import { generateKidIcs } from './src/ics.js';
import { ingestEmailForKid } from './src/matcher.js';
import { SAMPLE_FORWARD_EMAILS, seedDatabaseIfEmpty } from './src/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendFile(res, filePath, statusCode = 200) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': data.length,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60'
  });
  res.end(data);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) {
      throw new Error('Request body exceeds 2 MB limit.');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function parseRawEml(rawEml) {
  const normalized = String(rawEml || '').replace(/\r\n/g, '\n');
  const splitIdx = normalized.indexOf('\n\n');
  const headerBlock = splitIdx === -1 ? normalized : normalized.slice(0, splitIdx);
  const body = splitIdx === -1 ? '' : normalized.slice(splitIdx + 2).trim();

  const headers = {};
  let lastKey = null;
  for (const line of headerBlock.split('\n')) {
    if (/^\s+/.test(line) && lastKey) {
      headers[lastKey] += ' ' + line.trim();
    } else {
      const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (m) {
        lastKey = m[1].toLowerCase();
        headers[lastKey] = m[2].trim();
      }
    }
  }

  let receivedAt = new Date().toISOString();
  if (headers.date) {
    const parsedDate = Date.parse(headers.date);
    if (!Number.isNaN(parsedDate)) {
      receivedAt = new Date(parsedDate).toISOString();
    }
  }

  return {
    from_address: headers.from || 'forwarded@parent.mail',
    to_address: headers.to || '',
    subject: headers.subject || '(Forwarded Email)',
    received_at: receivedAt,
    body: body || normalized
  };
}

function normalizeWebhookPayload(payload) {
  if (payload.raw_eml) {
    return parseRawEml(payload.raw_eml);
  }
  const from = payload.from_address || payload.From || payload.from || payload.sender || 'forwarded@parent.mail';
  const to = payload.to_address || payload.To || payload.to || payload.recipient || '';
  const subject = payload.subject || payload.Subject || '(Forwarded Email)';
  const body = payload.body || payload.TextBody || payload['body-plain'] || payload.text || payload.HtmlBody || '';
  let receivedAt = payload.received_at || payload.Date || payload.date || new Date().toISOString();
  if (receivedAt && !/^\d{4}-\d{2}-\d{2}T/.test(receivedAt)) {
    const parsed = Date.parse(receivedAt);
    if (!Number.isNaN(parsed)) receivedAt = new Date(parsed).toISOString();
  }
  return {
    from_address: String(from),
    to_address: String(to),
    subject: String(subject),
    body: String(body),
    received_at: receivedAt,
    kid_slug: payload.kid_slug || null
  };
}

export function createAppServer({ db = getDb() } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';

      // API Routes
      if (pathname === '/api/meta' && method === 'GET') {
        return sendJson(res, 200, {
          inbox_domain: INBOX_DOMAIN,
          extractor: getActiveExtractorInfo(),
          sample_emails: SAMPLE_FORWARD_EMAILS
        });
      }

      if (pathname === '/api/kids' && method === 'GET') {
        return sendJson(res, 200, { kids: listKids(db) });
      }

      if (pathname === '/api/kids' && method === 'POST') {
        const body = await readJsonBody(req);
        const kid = createKid(db, body);
        return sendJson(res, 201, { kid });
      }

      const kidScheduleMatch = pathname.match(/^\/api\/kids\/([^/]+)\/schedule$/);
      if (kidScheduleMatch && method === 'GET') {
        const slug = decodeURIComponent(kidScheduleMatch[1]);
        const data = getKidScheduleData(db, slug);
        if (!data) return sendJson(res, 404, { error: 'Kid schedule not found.' });
        return sendJson(res, 200, data);
      }

      const kidIcsMatch = pathname.match(/^\/api\/kids\/([^/]+)\/calendar\.ics$/);
      if (kidIcsMatch && method === 'GET') {
        const slug = decodeURIComponent(kidIcsMatch[1]);
        const data = getKidScheduleData(db, slug);
        if (!data) return sendJson(res, 404, { error: 'Kid schedule not found.' });
        const ics = generateKidIcs(data);
        res.writeHead(200, {
          'content-type': 'text/calendar; charset=utf-8',
          'content-disposition': `attachment; filename="${data.kid.slug}-schedule.ics"`,
          'content-length': Buffer.byteLength(ics)
        });
        return res.end(ics);
      }

      const kidEmailMatch = pathname.match(/^\/api\/kids\/([^/]+)\/emails$/);
      if (kidEmailMatch && method === 'POST') {
        const slug = decodeURIComponent(kidEmailMatch[1]);
        const kid = getKidBySlug(db, slug);
        if (!kid) return sendJson(res, 404, { error: 'Kid not found.' });
        const payload = await readJsonBody(req);
        const normalized = normalizeWebhookPayload(payload);
        const result = await ingestEmailForKid(db, kid, normalized);
        return sendJson(res, 201, result);
      }

      if (pathname === '/api/inbound-email' && method === 'POST') {
        const payload = await readJsonBody(req);
        const normalized = normalizeWebhookPayload(payload);
        let kid = null;
        if (normalized.kid_slug) {
          kid = getKidBySlug(db, normalized.kid_slug);
        }
        if (!kid && normalized.to_address) {
          // Extract first email address from "Mia Yang <mia-yang@inbox.courtline.app>"
          const addrMatch = normalized.to_address.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/);
          kid = getKidByInboxEmail(db, addrMatch ? addrMatch[0] : normalized.to_address);
        }
        if (!kid) {
          return sendJson(res, 404, {
            error: 'No kid inbox matched recipient address. Include kid_slug or send to <slug>@' + INBOX_DOMAIN
          });
        }
        const result = await ingestEmailForKid(db, kid, normalized);
        return sendJson(res, 201, { kid, ...result });
      }

      const alertReadMatch = pathname.match(/^\/api\/alerts\/(\d+)\/read$/);
      if (alertReadMatch && method === 'POST') {
        const alertId = Number(alertReadMatch[1]);
        const payload = await readJsonBody(req);
        const updated = markAlertRead(db, alertId, payload.is_read !== false);
        if (!updated) return sendJson(res, 404, { error: 'Alert not found.' });
        return sendJson(res, 200, { alert: { ...updated, is_read: Boolean(updated.is_read) } });
      }

      const readAllMatch = pathname.match(/^\/api\/kids\/([^/]+)\/alerts\/read-all$/);
      if (readAllMatch && method === 'POST') {
        const slug = decodeURIComponent(readAllMatch[1]);
        const kid = getKidBySlug(db, slug);
        if (!kid) return sendJson(res, 404, { error: 'Kid not found.' });
        markAllAlertsRead(db, kid.id);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/demo/reset' && method === 'POST') {
        const freshDb = resetDatabase();
        await seedDatabaseIfEmpty(freshDb);
        db = freshDb;
        return sendJson(res, 200, { ok: true, message: 'Demo database reset to Mia Yang seed state.' });
      }

      // Static assets
      if (method === 'GET' && !pathname.startsWith('/api/')) {
        const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
        const candidate = path.join(PUBLIC_DIR, safePath);
        if (safePath !== '/' && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return sendFile(res, candidate);
        }
        // Client-side SPA routes: /, /inbox, /kid/:slug, /kid/:slug/inbox
        return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[server] Error handling request:', err);
      return sendJson(res, 400, { error: err.message || 'Bad request' });
    }
  });
}

// Start server when run directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const PORT = Number(process.env.PORT || 3000);
  const db = getDb();
  await seedDatabaseIfEmpty(db);
  const server = createAppServer({ db });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Courtline V1 running at http://localhost:${PORT}`);
    console.log(`Extractor: ${getActiveExtractorInfo().label}`);
  });
}
