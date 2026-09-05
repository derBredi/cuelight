// server.js
// Drei Aufgaben:
// 1) Eine gueltige Meeting-SDK-Signatur (JWT) ausstellen, damit das Board
//    sich als Teilnehmer in ein Meeting einklinken darf.
// 2) Seit Zooms Attributions-Pflicht (2. Maerz 2026) zusaetzlich ein
//    "On Behalf Of"-Token (OBF) besorgen, wenn die App in einem ANDEREN
//    Zoom-Account erstellt wurde als dem, der das Meeting hostet. Dafuer
//    muss der Meeting-Host die App einmalig per OAuth freigeben.
// 3) Den ganzen Dienst hinter einem optionalen Zugriffsschluessel halten
//    (CUELIGHT_ACCESS_TOKEN), damit eine oeffentlich erreichbare Instanz
//    nicht von Fremden benutzt oder umautorisiert werden kann.
// Alle Zugangsdaten bleiben serverseitig, nie im Browser sichtbar.

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // laeuft hinter cloudflared / nginx / Caddy

// --- SDK-Zugangsdaten (fuer die Signatur / den Beitritt selbst) ---------
const SDK_KEY = process.env.ZOOM_MEETING_SDK_KEY;
const SDK_SECRET = process.env.ZOOM_MEETING_SDK_SECRET;

// --- OAuth-Zugangsdaten (fuer die einmalige Freigabe durch den Host) ----
const OAUTH_CLIENT_ID = process.env.ZOOM_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.ZOOM_OAUTH_CLIENT_SECRET;
// Oeffentlich erreichbare Basis-URL, z. B. https://cuelight.deine-domain.de
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const IS_HTTPS = APP_BASE_URL.startsWith('https://');

// --- Zugriffsschutz -----------------------------------------------------
// Optional, aber dringend empfohlen, sobald die Instanz aus dem Internet
// erreichbar ist: ein frei gewaehlter langer Schluessel. Ohne ihn kommt
// niemand an /api/signature, /api/obf-token oder /oauth/authorize.
// Einmal https://deine-domain.de/?k=DEIN_SCHLUESSEL oeffnen - danach
// merkt sich der Browser den Schluessel in einem Cookie.
const ACCESS_TOKEN = process.env.CUELIGHT_ACCESS_TOKEN || '';

// Optional: nur dieses Zoom-Konto darf die App autorisieren. Verhindert,
// dass sich ein Fremder unter /oauth/authorize einklinkt und damit die
// gespeicherte Freigabe des richtigen Hosts ueberschreibt.
const ALLOWED_ACCOUNT_ID = process.env.ZOOM_ALLOWED_ACCOUNT_ID || '';

// Notausgang, falls die Content-Security-Policy mit einer kuenftigen
// SDK-Version kollidiert: CUELIGHT_DISABLE_CSP=1 setzen.
const DISABLE_CSP = process.env.CUELIGHT_DISABLE_CSP === '1';

if (!SDK_KEY || !SDK_SECRET) {
  console.warn(
    '[Achtung] ZOOM_MEETING_SDK_KEY / ZOOM_MEETING_SDK_SECRET fehlen. ' +
    'Bitte in der .env bzw. docker-compose.yml eintragen.'
  );
}
if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !APP_BASE_URL) {
  console.warn(
    '[Achtung] ZOOM_OAUTH_CLIENT_ID / ZOOM_OAUTH_CLIENT_SECRET / APP_BASE_URL ' +
    'fehlen. Ohne diese kann der Meeting-Host die App nicht per OAuth freigeben.'
  );
}
if (!ACCESS_TOKEN) {
  console.warn(
    '[Achtung] CUELIGHT_ACCESS_TOKEN ist nicht gesetzt - der Dienst ist fuer ' +
    'jeden nutzbar, der die URL kennt. Nur ohne oeffentliche Erreichbarkeit ' +
    'oder hinter einer eigenen Zugriffskontrolle (z. B. Cloudflare Access) ok.'
  );
}

// -------------------------------------------------------------------
// Kleine Helfer ohne zusaetzliche Abhaengigkeiten
// -------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAge, path: cookiePath = '/' } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${cookiePath}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (IS_HTTPS) parts.push('Secure');
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? [].concat(existing) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

// Vergleich in konstanter Zeit, damit ein Angreifer den Schluessel nicht
// Zeichen fuer Zeichen ueber Antwortzeiten erraten kann.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// fetch mit Zeitlimit: haengt Zoom, soll der Beitritt nicht ewig warten.
async function fetchWithTimeout(url, options = {}, ms = 8000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

// Sehr einfaches Mengenlimit pro IP - reicht, um Durchprobieren von
// Meeting-Nummern unattraktiv zu machen.
const rateBuckets = new Map();
function rateLimit({ max, windowMs }) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    bucket.count += 1;
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (now > bucket.resetAt) rateBuckets.delete(key);
}, 60_000).unref();

// -------------------------------------------------------------------
// Basis-Middleware
// -------------------------------------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (IS_HTTPS) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  if (!DISABLE_CSP) {
    // 'unsafe-inline'/'unsafe-eval' sind noetig: die App ist ein einzelnes
    // HTML mit Inline-Skript, und das Zoom-SDK laedt WebAssembly nach.
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://source.zoom.us",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://*.zoom.us",
        "font-src 'self' data:",
        "connect-src 'self' https://*.zoom.us wss://*.zoom.us",
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; ')
    );
  }
  next();
});

// CORS nur fuer die eigene Domain - vorher war jede fremde Website
// berechtigt, hier Signaturen abzuholen.
const allowedOrigins = [APP_BASE_URL].filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false, credentials: true }));

// Zugriffsschluessel pruefen (falls gesetzt) - gilt fuer ALLES, auch fuer
// die Seite selbst, /oauth/authorize und die API.
app.use((req, res, next) => {
  if (!ACCESS_TOKEN) return next();
  const cookies = parseCookies(req);
  if (safeEqual(cookies.cl_access || '', ACCESS_TOKEN)) return next();

  const provided = typeof req.query.k === 'string' ? req.query.k : '';
  if (safeEqual(provided, ACCESS_TOKEN)) {
    setCookie(res, 'cl_access', ACCESS_TOKEN, { maxAge: 60 * 60 * 24 * 90 });
    // Schluessel wieder aus der URL nehmen, damit er nicht in Lesezeichen,
    // Verlauf oder Screenshots stehen bleibt.
    const url = new URL(req.originalUrl, 'http://localhost');
    url.searchParams.delete('k');
    return res.redirect(url.pathname + (url.search || ''));
  }

  res
    .status(401)
    .type('text/plain; charset=utf-8')
    .send('CueLight: Zugriffsschluessel fehlt. Seite einmal mit ?k=DEIN_SCHLUESSEL oeffnen.');
});

app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Sicherheitsnetz: ein einzelner unerwarteter Fehler soll waehrend der
// Veranstaltung nichts stillschweigend kaputtlassen. Bewusst MIT Exit:
// ein Prozess in undefiniertem Zustand ist gefaehrlicher als ein
// Neustart, den Docker dank "restart: unless-stopped" in unter einer
// Sekunde erledigt.
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
  process.exit(1);
});

// -------------------------------------------------------------------
// Token-Speicher: die OAuth-Tokens des Hosts landen in einer kleinen
// JSON-Datei auf einem Docker-Volume, damit sie einen Container-Neustart
// ueberleben. Datei- und Verzeichnisrechte bewusst eng - sie enthaelt ein
// gueltiges Refresh-Token.
// -------------------------------------------------------------------
const TOKEN_FILE = path.join(__dirname, 'data', 'zoom-oauth-tokens.json');

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  // Atomar schreiben: ein Absturz mitten im Schreiben darf keine halbe
  // (= unbrauchbare) Datei hinterlassen.
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

function clearTokens() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {
    /* war schon weg */
  }
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64');
}

// Liefert ein gueltiges Access-Token des Hosts, erneuert es bei Bedarf.
// Wichtig: nur EIN Refresh gleichzeitig. Zoom rotiert das Refresh-Token
// bei jedem Einloesen - zwei parallele Refreshes wuerden dazu fuehren,
// dass das zuletzt gespeicherte Token bereits verbrannt ist.
let refreshInFlight = null;

async function getValidAccessToken() {
  const tokens = loadTokens();
  if (!tokens) return null;

  const stillValid = tokens.expires_at && Date.now() < tokens.expires_at - 60_000;
  if (stillValid) return tokens.access_token;

  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(tokens).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function refreshAccessToken(tokens) {
  const res = await fetchWithTimeout('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Konnte Zoom-Token nicht erneuern:', body);
    // Refresh-Token endgueltig ungueltig -> gespeicherte Freigabe wegwerfen,
    // damit /oauth/status ehrlich "nicht autorisiert" meldet, statt die
    // Oberflaeche in falscher Sicherheit zu wiegen.
    if (res.status === 400 || res.status === 401) clearTokens();
    return null;
  }

  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expires_at: Date.now() + fresh.expires_in * 1000,
  };
  saveTokens(updated);
  return updated.access_token;
}

// --- 1) Meeting-Host startet hier die einmalige Freigabe -----------------
app.get('/oauth/authorize', (req, res) => {
  if (!OAUTH_CLIENT_ID || !APP_BASE_URL) {
    return res.status(500).send('Server nicht konfiguriert (ZOOM_OAUTH_CLIENT_ID / APP_BASE_URL fehlen).');
  }
  // state gegen CSRF: ohne diesen Wert koennte jemand den Betreiber auf
  // /oauth/callback?code=SEIN_CODE locken und die gespeicherte Freigabe
  // durch seine eigene ersetzen.
  const state = crypto.randomBytes(24).toString('base64url');
  setCookie(res, 'cl_oauth_state', state, { maxAge: 600, path: '/oauth' });

  const url = new URL('https://zoom.us/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${APP_BASE_URL}/oauth/callback`);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// --- 2) Zoom schickt den Host hierher zurueck -----------------------------
app.get('/oauth/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.status(400).send(`Zoom hat die Freigabe abgelehnt: ${error}`);
  if (!code) return res.status(400).send('Kein code von Zoom erhalten.');

  const expectedState = parseCookies(req).cl_oauth_state || '';
  if (!expectedState || !safeEqual(String(state || ''), expectedState)) {
    return res
      .status(400)
      .send('Ungueltige oder abgelaufene Freigabe-Anfrage. Bitte erneut ueber /oauth/authorize starten.');
  }
  setCookie(res, 'cl_oauth_state', '', { maxAge: 0, path: '/oauth' });

  try {
    const tokenRes = await fetchWithTimeout('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${APP_BASE_URL}/oauth/callback`,
      }),
    });

    if (!tokenRes.ok) {
      console.error('Token-Austausch fehlgeschlagen:', await tokenRes.text());
      return res.status(500).send('Token-Austausch mit Zoom fehlgeschlagen, siehe Server-Log.');
    }

    const data = await tokenRes.json();

    // Wer hat da eigentlich autorisiert? Wird angezeigt und - falls
    // ZOOM_ALLOWED_ACCOUNT_ID gesetzt ist - auch geprueft.
    let account = {};
    try {
      const meRes = await fetchWithTimeout('https://api.zoom.us/v2/users/me', {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (meRes.ok) {
        const me = await meRes.json();
        account = { account_id: me.account_id, email: me.email, display_name: me.display_name };
      }
    } catch (err) {
      console.warn('Konnte Kontodaten nicht abrufen:', err);
    }

    if (ALLOWED_ACCOUNT_ID && account.account_id !== ALLOWED_ACCOUNT_ID) {
      console.warn('Freigabe abgelehnt, fremdes Zoom-Konto:', account.account_id);
      return res
        .status(403)
        .send('Dieses Zoom-Konto ist fuer diese CueLight-Instanz nicht freigegeben.');
    }

    saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      account,
      authorized_at: new Date().toISOString(),
    });

    res.type('html').send(
      '<h1>Freigabe erfolgreich</h1>' +
      `<p>CueLight darf jetzt im Namen von ${account.email || 'diesem Konto'} Meetings beitreten. ` +
      'Du kannst dieses Fenster schliessen.</p>'
    );
  } catch (err) {
    console.error('Fehler in /oauth/callback:', err);
    res.status(500).send('Unerwarteter Fehler beim Verarbeiten der Zoom-Freigabe, siehe Server-Log.');
  }
});

// Fuer die Anzeige im Board: ist der Host schon einmalig freigegeben?
app.get('/oauth/status', (req, res) => {
  const tokens = loadTokens();
  res.json({
    authorized: !!tokens,
    account: tokens && tokens.account ? tokens.account.email || null : null,
  });
});

// --- 3) OBF-Token fuer den eigentlichen Beitritt --------------------------
// GET /api/obf-token?meetingNumber=123456789
// Achtung: gibt ein Token heraus, das gegenueber Zoom im Namen des
// autorisierten Hosts wirkt - deshalb liegt der Endpunkt hinter dem
// Zugriffsschluessel oben und hinter einem Mengenlimit.
app.get('/api/obf-token', rateLimit({ max: 30, windowMs: 60_000 }), async (req, res) => {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      return res.status(401).json({
        error: 'not_authorized',
        message: 'Der Meeting-Host hat die App noch nicht freigegeben. Bitte /oauth/authorize aufrufen.',
      });
    }

    const meetingNumber = String(req.query.meetingNumber || '');
    const url = new URL('https://api.zoom.us/v2/users/me/token');
    url.searchParams.set('type', 'onbehalf');
    if (/^\d{9,12}$/.test(meetingNumber)) url.searchParams.set('meeting_id', meetingNumber);

    const obfRes = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!obfRes.ok) {
      console.error('OBF-Token-Abruf fehlgeschlagen:', await obfRes.text());
      return res.status(502).json({ error: 'obf_request_failed' });
    }

    const data = await obfRes.json();
    res.json({ obfToken: data.token });
  } catch (err) {
    console.error('Fehler in /api/obf-token:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/signature   Body: { meetingNumber: "123456789" }
// Die Rolle ist bewusst fest auf 0 (Teilnehmer) verdrahtet: CueLight hoert
// nur zu. Host-Rechte im Meeting bekommt es ggf. per Co-Host-Vergabe durch
// den Host, nicht ueber die Signatur.
app.post('/api/signature', rateLimit({ max: 30, windowMs: 60_000 }), (req, res) => {
  const { meetingNumber } = req.body || {};

  if (!/^\d{9,12}$/.test(String(meetingNumber || ''))) {
    return res.status(400).json({ error: 'meetingNumber ungueltig (9-12 Ziffern erwartet)' });
  }
  if (!SDK_KEY || !SDK_SECRET) {
    return res.status(500).json({ error: 'Server nicht konfiguriert (siehe .env)' });
  }

  const iat = Math.floor(Date.now() / 1000) - 30; // 30s Puffer gegen Uhr-Drift
  const exp = iat + 60 * 60 * 2; // 2 Stunden Gueltigkeit

  const payload = {
    appKey: SDK_KEY,
    sdkKey: SDK_KEY,
    mn: String(meetingNumber),
    role: 0,
    iat,
    exp,
    tokenExp: exp,
  };

  const signature = jwt.sign(payload, SDK_SECRET, { algorithm: 'HS256' });
  res.json({ signature });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Signature-Server laeuft auf http://localhost:${PORT}`);
  console.log(`Board oeffnen unter http://localhost:${PORT}/`);
});
