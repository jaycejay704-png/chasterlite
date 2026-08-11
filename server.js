/**
 * Chaster Lite – simple Node.js server (no external deps)
 * Stores sessions in ./data/sessions.json and images in ./uploads/
 * Run: node server.js
 * Then open http://localhost:3847
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3847;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Ensure directories
[DATA_DIR, UPLOAD_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ---------- Session store ----------
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not load sessions', e.message);
  }
  return {};
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

let sessions = loadSessions();

// Clean very old sessions (> 30 days) on start
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
Object.keys(sessions).forEach(code => {
  if (Date.now() - (sessions[code].createdAt || 0) > THIRTY_DAYS) {
    const s = sessions[code];
    if (s.imageFile) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, s.imageFile)); } catch (_) {}
    }
    delete sessions[code];
  }
});
saveSessions(sessions);

// ---------- Helpers ----------
function generateSessionCode() {
  // Short readable code: 4 letters + 4 digits
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
  code += '-';
  for (let i = 0; i < 4; i++) code += digits[crypto.randomInt(digits.length)];
  return code;
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 15 * 1024 * 1024) { // 15 MB limit
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getRemaining(session) {
  if (!session || session.status !== 'locked') return 0;
  if (session.frozen) return session.remainingAtFreeze || 0;
  return Math.max(0, session.endTime - Date.now());
}

function publicSession(session, revealCombo = false) {
  if (!session) return null;
  const remaining = getRemaining(session);
  const out = {
    code: session.code,
    status: session.status,
    frozen: !!session.frozen,
    remainingMs: remaining,
    hasImage: !!session.imageFile,
    startTime: session.startTime,
    endTime: session.endTime,
    durationMs: session.durationMs,
    unlockedAt: session.unlockedAt || null,
    unlockReason: session.unlockReason || null,
    createdAt: session.createdAt
  };
  if (revealCombo && session.status === 'unlocked') {
    if (session.fallbackCode) out.fallbackCode = session.fallbackCode;
    // image is served via separate endpoint when unlocked
  }
  return out;
}

// ---------- API handlers ----------
async function handleCreate(req, res) {
  try {
    const body = await parseBody(req);
    const { durationMs, pin, imageBase64, mimeType } = body;

    if (!durationMs || durationMs < 60 * 1000) {
      return json(res, 400, { error: 'Duration must be at least 1 minute' });
    }
    if (durationMs > 365 * 24 * 60 * 60 * 1000) {
      return json(res, 400, { error: 'Duration too long' });
    }

    let code;
    do {
      code = generateSessionCode();
    } while (sessions[code]);

    let imageFile = null;
    if (imageBase64 && typeof imageBase64 === 'string') {
      const match = imageBase64.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      const data = match ? match[2] : imageBase64;
      const ext = (match && match[1].includes('png')) ? 'png' :
                  (match && match[1].includes('webp')) ? 'webp' : 'jpg';
      imageFile = `${code.replace('-', '')}_${Date.now()}.${ext}`;
      const buf = Buffer.from(data, 'base64');
      if (buf.length > 12 * 1024 * 1024) {
        return json(res, 400, { error: 'Image too large (max ~12 MB)' });
      }
      fs.writeFileSync(path.join(UPLOAD_DIR, imageFile), buf);
    }

    const fallbackCode = Array.from({ length: 6 }, () => crypto.randomInt(10)).join('');

    const session = {
      code,
      status: 'locked',
      startTime: Date.now(),
      endTime: Date.now() + durationMs,
      durationMs,
      frozen: false,
      remainingAtFreeze: null,
      pin: pin && String(pin).length >= 4 ? String(pin) : null,
      imageFile,
      fallbackCode,
      unlockedAt: null,
      unlockReason: null,
      createdAt: Date.now()
    };

    sessions[code] = session;
    saveSessions(sessions);

    json(res, 200, {
      code,
      session: publicSession(session),
      message: 'Lock created. Share the session code with your keyholder.'
    });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message || 'Server error' });
  }
}

async function handleGet(req, res, code) {
  const session = sessions[code];
  if (!session) return json(res, 404, { error: 'Session not found' });

  // Auto-unlock if timer expired
  if (session.status === 'locked' && !session.frozen && getRemaining(session) <= 0) {
    session.status = 'unlocked';
    session.unlockedAt = Date.now();
    session.unlockReason = 'timer';
    session.frozen = false;
    saveSessions(sessions);
  }

  json(res, 200, { session: publicSession(session, true) });
}

async function handleKeyholderAction(req, res, code) {
  try {
    const body = await parseBody(req);
    const { pin, action, minutes } = body;
    const session = sessions[code];

    if (!session) return json(res, 404, { error: 'Session not found' });
    if (session.status !== 'locked') {
      return json(res, 400, { error: 'Lock is already unlocked' });
    }

    // PIN check
    if (session.pin) {
      if (!pin || pin !== session.pin) {
        return json(res, 403, { error: 'Invalid keyholder PIN' });
      }
    }

    if (action === 'add_time') {
      const delta = (Number(minutes) || 0) * 60 * 1000;
      if (session.frozen) {
        session.remainingAtFreeze = Math.max(0, (session.remainingAtFreeze || 0) + delta);
      } else {
        session.endTime = Math.max(Date.now(), session.endTime + delta);
      }
    } else if (action === 'freeze') {
      if (!session.frozen) {
        session.remainingAtFreeze = getRemaining(session);
        session.frozen = true;
      }
    } else if (action === 'unfreeze') {
      if (session.frozen) {
        session.endTime = Date.now() + (session.remainingAtFreeze || 0);
        session.frozen = false;
        session.remainingAtFreeze = null;
      }
    } else if (action === 'unlock') {
      session.status = 'unlocked';
      session.unlockedAt = Date.now();
      session.unlockReason = 'keyholder';
      session.frozen = false;
    } else {
      return json(res, 400, { error: 'Unknown action' });
    }

    saveSessions(sessions);
    json(res, 200, { session: publicSession(session, true) });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message || 'Server error' });
  }
}

async function handleImage(req, res, code) {
  const session = sessions[code];
  if (!session) return json(res, 404, { error: 'Not found' });
  if (session.status !== 'unlocked') {
    return json(res, 403, { error: 'Combination still locked' });
  }
  if (!session.imageFile) {
    return json(res, 404, { error: 'No image' });
  }

  const filePath = path.join(UPLOAD_DIR, session.imageFile);
  if (!fs.existsSync(filePath)) {
    return json(res, 404, { error: 'Image file missing' });
  }

  const ext = path.extname(session.imageFile).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'private, max-age=3600',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleDiscard(req, res, code) {
  try {
    const body = await parseBody(req);
    const session = sessions[code];
    if (!session) return json(res, 404, { error: 'Not found' });

    // Optional: require a discard token or just allow anyone with the code for simplicity
    // For personal use we allow discard with the session code.
    if (session.imageFile) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, session.imageFile)); } catch (_) {}
    }
    delete sessions[code];
    saveSessions(sessions);
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

// ---------- Static file server ----------
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, urlPath) {
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  // Security: prevent path traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- Main server ----------
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // API routes
    if (pathname === '/api/create' && req.method === 'POST') {
      return await handleCreate(req, res);
    }

    const sessionMatch = pathname.match(/^\/api\/session\/([A-Z0-9-]+)$/);
    if (sessionMatch) {
      const code = sessionMatch[1].toUpperCase();
      if (req.method === 'GET') return await handleGet(req, res, code);
      if (req.method === 'POST') return await handleKeyholderAction(req, res, code);
    }

    const imageMatch = pathname.match(/^\/api\/session\/([A-Z0-9-]+)\/image$/);
    if (imageMatch && req.method === 'GET') {
      return await handleImage(req, res, imageMatch[1].toUpperCase());
    }

    const discardMatch = pathname.match(/^\/api\/session\/([A-Z0-9-]+)\/discard$/);
    if (discardMatch && req.method === 'POST') {
      return await handleDiscard(req, res, discardMatch[1].toUpperCase());
    }

    // Static files
    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\n🔒 Chaster Lite running at http://localhost:${PORT}`);
  console.log(`   Share the URL + session code with your keyholder.\n`);
});
