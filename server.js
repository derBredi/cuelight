// server.js
// Drei Aufgaben:
// 1) Eine gueltige Meeting-SDK-Signatur (JWT) ausstellen, damit das Board
//    sich als Teilnehmer in ein Meeting einklinken darf.
// 2) Seit Zooms Attributions-Pflicht (2. Maerz 2026) zusaetzlich ein
//    "On Behalf Of"-Token (OBF) besorgen, wenn die App in einem ANDEREN
//    Zoom-Account erstellt wurde als dem, der das Meeting hostet. Dafuer
//    muss der Meeting-Host die App einmalig per OAuth freigeben.
// 3) Den ganzen Dienst optional hinter einem Passwort halten
//    (CUELIGHT_PASSWORD), damit eine oeffentlich erreichbare Instanz
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

// --- Zugangsdaten der eigenen Zoom-App ----------------------------------
// Eine "General App" bei Zoom hat genau EINE Client ID und EIN Client
// Secret - dieselben Werte gelten fuer das Meeting SDK und fuer OAuth.
// Deshalb gibt es hier auch nur zwei Felder. Die alten, vierfachen
// Variablennamen funktionieren weiterhin, damit bestehende Installationen
// nach einem Update nicht stehenbleiben.
const CLIENT_ID = process.env.ZOOM_CLIENT_ID || process.env.ZOOM_MEETING_SDK_KEY || process.env.ZOOM_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || process.env.ZOOM_MEETING_SDK_SECRET || process.env.ZOOM_OAUTH_CLIENT_SECRET || '';

const SDK_KEY = process.env.ZOOM_MEETING_SDK_KEY || CLIENT_ID;
const SDK_SECRET = process.env.ZOOM_MEETING_SDK_SECRET || CLIENT_SECRET;
const OAUTH_CLIENT_ID = process.env.ZOOM_OAUTH_CLIENT_ID || CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.ZOOM_OAUTH_CLIENT_SECRET || CLIENT_SECRET;

// Unter welcher Adresse ist CueLight erreichbar? Wird normalerweise aus
// der Anfrage selbst abgeleitet (der Reverse-Proxy schickt Protokoll und
// Hostname mit), sodass man sie nirgends eintragen muss. APP_BASE_URL
// ueberschreibt das nur, falls die Ableitung mal nicht passt.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

function baseUrl(req) {
  if (APP_BASE_URL) return APP_BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}

// Cookies nur dann als "Secure" markieren, wenn die Verbindung wirklich
// ueber HTTPS laeuft - sonst kaeme ein reiner LAN-Test ohne TLS nicht
// durch die Anmeldung.
function isSecure(req) {
  return req.protocol === 'https' || APP_BASE_URL.startsWith('https://');
}

// --- Zugriffsschutz -----------------------------------------------------
// Optional: ein selbst gewaehltes Passwort. Ist es gesetzt, fragt CueLight
// beim ersten Aufruf einmal danach und merkt es sich danach im Browser.
// Leer lassen, wenn CueLight nicht oeffentlich erreichbar ist oder schon
// eine eigene Zugriffskontrolle davor haengt (z. B. Cloudflare Access).
const ACCESS_TOKEN = process.env.CUELIGHT_PASSWORD || process.env.CUELIGHT_ACCESS_TOKEN || '';

// Notausgang, falls die Content-Security-Policy mit einer kuenftigen
// SDK-Version kollidiert: CUELIGHT_DISABLE_CSP=1 setzen.
const DISABLE_CSP = process.env.CUELIGHT_DISABLE_CSP === '1';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn(
    '[Achtung] ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET fehlen. Bitte in der ' +
    'docker-compose.yml unter "environment:" eintragen - ohne sie kann ' +
    'CueLight keinem Meeting beitreten.'
  );
}
console.log(
  ACCESS_TOKEN
    ? 'Passwortschutz aktiv: beim ersten Aufruf fragt CueLight einmal danach.'
    : 'Kein Passwort gesetzt (CUELIGHT_PASSWORD leer) - jeder, der die ' +
      'Adresse kennt, kann CueLight benutzen. In Ordnung im Heimnetz oder ' +
      'hinter einer eigenen Zugriffskontrolle, sonst bitte setzen.'
);

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

function setCookie(res, name, value, { maxAge, path: cookiePath = '/', secure = false } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${cookiePath}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
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
  if (isSecure(req)) {
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

// CORS aus: die Seite kommt vom selben Server wie die API, fremde
// Websites haben hier nichts abzuholen. (Vorher war jede Origin erlaubt.)
app.use(cors({ origin: false }));

// --- Entsperr-Seite -----------------------------------------------------
// Einmal den Schluessel in ein Feld eintippen statt ihn an die URL zu
// haengen: der Browser bietet ihn danach als gespeichertes Passwort an,
// er landet nicht im Verlauf, und Sonderzeichen koennen nichts kaputt
// machen. Diese beiden Routen liegen bewusst VOR der Zugriffspruefung.
function unlockPage({ wrong = false } = {}) {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CueLight entsperren</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center;
    justify-content:center; background:#1c1c2e; color:#f2f3f5;
    font-family:-apple-system,"Segoe UI",Roboto,sans-serif; }
  form { width:min(90vw,380px); padding:32px; background:#26263c;
    border:1px solid #38384f; border-radius:12px; }
  h1 { margin:0 0 8px; font-size:22px; }
  p { margin:0 0 22px; font-size:13px; line-height:1.5; color:#8f8fa8; }
  input { width:100%; box-sizing:border-box; padding:12px; font-size:16px;
    background:#000; color:#f2f3f5; border:1px solid #38384f;
    border-radius:6px; }
  button { width:100%; margin-top:16px; min-height:48px; font-size:16px;
    font-weight:600; color:#fff; background:#2d8cff; border:none;
    border-radius:6px; cursor:pointer; }
  .err { margin:14px 0 0; padding:10px 12px; font-size:13px; color:#f2f3f5;
    background:rgba(220,38,38,0.15); border:1px solid #dc2626;
    border-radius:6px; }
</style></head><body>
<form method="POST" action="/unlock">
  <h1>CueLight</h1>
  <p>Einmal pro Gerät das Passwort eintragen. Danach merkt sich der
     Browser die Freigabe.</p>
  <input type="password" name="key" autocomplete="current-password"
         autofocus placeholder="Passwort" />
  <button type="submit">Anmelden</button>
  ${wrong ? '<p class="err">Passwort stimmt nicht. Es ist der Wert, der in der docker-compose.yml bei CUELIGHT_PASSWORD steht.</p>' : ''}
</form></body></html>`;
}

app.get('/unlock', (req, res) => {
  if (!ACCESS_TOKEN) return res.redirect('/');
  res.type('html').send(unlockPage());
});

app.post(
  '/unlock',
  express.urlencoded({ extended: false, limit: '2kb' }),
  rateLimit({ max: 10, windowMs: 60_000 }),
  (req, res) => {
    if (!ACCESS_TOKEN) return res.redirect('/');
    const key = String((req.body && req.body.key) || '').trim();
    if (safeEqual(key, ACCESS_TOKEN)) {
      setCookie(res, 'cl_access', ACCESS_TOKEN, {
        maxAge: 60 * 60 * 24 * 365,
        secure: isSecure(req),
      });
      return res.redirect('/');
    }
    res.status(401).type('html').send(unlockPage({ wrong: true }));
  }
);

// Zugriffsschluessel pruefen (falls gesetzt) - gilt fuer ALLES, auch fuer
// die Seite selbst, /oauth/authorize und die API.
app.use((req, res, next) => {
  if (!ACCESS_TOKEN) return next();
  const cookies = parseCookies(req);
  if (safeEqual(cookies.cl_access || '', ACCESS_TOKEN)) return next();

  // ?k=... funktioniert weiterhin, z. B. fuer ein vorbereitetes Lesezeichen.
  // Ein "+" im Schluessel kommt in der Query als Leerzeichen an - deshalb
  // beide Schreibweisen pruefen.
  const raw = typeof req.query.k === 'string' ? req.query.k : '';
  if (raw && (safeEqual(raw, ACCESS_TOKEN) || safeEqual(raw.replace(/ /g, '+'), ACCESS_TOKEN))) {
    setCookie(res, 'cl_access', ACCESS_TOKEN, {
      maxAge: 60 * 60 * 24 * 365,
      secure: isSecure(req),
    });
    // Schluessel wieder aus der URL nehmen, damit er nicht in Lesezeichen,
    // Verlauf oder Screenshots stehen bleibt.
    const url = new URL(req.originalUrl, 'http://localhost');
    url.searchParams.delete('k');
    return res.redirect(url.pathname + (url.search || ''));
  }

  // Normaler Seitenaufruf -> Entsperr-Formular. API-Aufrufe bekommen
  // weiterhin eine kurze, maschinenlesbare Antwort.
  const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
  if (wantsHtml) return res.redirect('/unlock');
  res.status(401).json({ error: 'locked', message: 'Passwort fehlt.' });
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
  if (!OAUTH_CLIENT_ID) {
    return res.status(500).send('Server nicht konfiguriert: ZOOM_CLIENT_ID fehlt.');
  }
  // state gegen CSRF: ohne diesen Wert koennte jemand den Betreiber auf
  // /oauth/callback?code=SEIN_CODE locken und die gespeicherte Freigabe
  // durch seine eigene ersetzen.
  const state = crypto.randomBytes(24).toString('base64url');
  setCookie(res, 'cl_oauth_state', state, {
    maxAge: 600,
    path: '/oauth',
    secure: isSecure(req),
  });

  const url = new URL('https://zoom.us/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${baseUrl(req)}/oauth/callback`);
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
  setCookie(res, 'cl_oauth_state', '', { maxAge: 0, path: '/oauth', secure: isSecure(req) });

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
        redirect_uri: `${baseUrl(req)}/oauth/callback`,
      }),
    });

    if (!tokenRes.ok) {
      console.error('Token-Austausch fehlgeschlagen:', await tokenRes.text());
      return res.status(500).send('Token-Austausch mit Zoom fehlgeschlagen, siehe Server-Log.');
    }

    const data = await tokenRes.json();

    // Wer hat da eigentlich autorisiert? Wird angezeigt und mit einer
    // eventuell schon vorhandenen Freigabe verglichen.
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

    // Das erste Konto, das freigibt, gehoert zu dieser Instanz. Ein
    // spaeteres, anderes Konto wird abgewiesen - sonst koennte ein Fremder
    // die Freigabe des richtigen Hosts einfach ueberschreiben. Kein
    // Konfigurationsfeld noetig: die Instanz merkt sich das selbst.
    const existing = loadTokens();
    if (
      existing &&
      existing.account &&
      existing.account.account_id &&
      account.account_id &&
      existing.account.account_id !== account.account_id
    ) {
      console.warn('Freigabe abgelehnt, anderes Zoom-Konto:', account.account_id);
      return res
        .status(403)
        .send(
          'Diese CueLight-Instanz ist bereits fuer ein anderes Zoom-Konto ' +
          `freigegeben (${existing.account.email || existing.account.account_id}). ` +
          'Zum Wechseln die Datei data/zoom-oauth-tokens.json loeschen und ' +
          'den Container neu starten.'
        );
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
    return res.status(500).json({
      error: 'Server nicht konfiguriert: ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET fehlen',
    });
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
