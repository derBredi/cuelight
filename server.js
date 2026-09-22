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
const { version: PACKAGE_VERSION } = require('./package.json');
const cors = require('cors');
const jwt = require('jsonwebtoken');
// Eine Zeile Rechnung in einer eigenen Datei - weil sie einen Fehler
// hatte, den man ihr nicht ansieht, und weil sie sich so pruefen laesst,
// ohne den Server zu starten. Die Begruendung steht in lib/ablauf.js.
const { ablaufZeitpunkt } = require('./lib/ablauf');
// Sagt beim Start, was noch fehlt - und zwar an einer Stelle statt in drei
// verstreuten console-Aufrufen. Siehe lib/selbstpruefung.js.
const { selbstpruefung, berichtAlsText } = require('./lib/selbstpruefung');

const app = express();
app.disable('x-powered-by');
// Laeuft normalerweise hinter cloudflared / nginx / Caddy, deshalb wird
// dem X-Forwarded-For des ersten Proxys vertraut - sonst saehen alle
// Anfragen wie dieselbe IP aus und das Mengenlimit unten waere wertlos.
// Wer CueLight OHNE Proxy direkt erreichbar macht, setzt
// CUELIGHT_TRUST_PROXY=0: dann zaehlt nur noch die echte Verbindungs-IP,
// und niemand kann sich das Limit per gefaelschtem Header wegdrehen.
app.set('trust proxy', process.env.CUELIGHT_TRUST_PROXY === '0' ? false : 1);

// --- Zugangsdaten der eigenen Zoom-App ----------------------------------
// Eine "General App" bei Zoom hat genau EINE Client ID und EIN Client
// Secret - dieselben Werte gelten fuer das Meeting SDK und fuer OAuth.
// Deshalb gibt es hier auch nur zwei Felder.
const CLIENT_ID = process.env.ZOOM_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || '';

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
const ACCESS_TOKEN = process.env.CUELIGHT_PASSWORD || '';

// Im Cookie steht nicht das Passwort selbst, sondern ein daraus
// abgeleiteter Wert. HttpOnly schuetzt vor Zugriff aus JavaScript, aber ein
// Geraete-Backup oder ein Cookie-Export haette sonst das Passwort im
// Klartext enthalten. Aus dem abgeleiteten Wert laesst es sich nicht
// zurueckrechnen; ein geaendertes Passwort macht weiterhin alle
// bestehenden Anmeldungen ungueltig.
const ACCESS_COOKIE = ACCESS_TOKEN
  ? crypto.createHmac('sha256', ACCESS_TOKEN).update('cl_access.v1').digest('base64url')
  : '';

// --- Zweite Stufe fuer die Zoom-Freigabe --------------------------------
// Optional und rein additiv: Ist CUELIGHT_ADMIN_PASSWORD leer, verhaelt sich
// alles wie bisher.
// Warum es das gibt: /oauth/authorize und /oauth/reset entscheiden, in
// wessen Namen diese Instanz Meetings beitritt. Mit nur einem Passwort darf
// jeder, der CueLight bedienen darf, die Freigabe auch wegwerfen oder durch
// sein eigenes Konto ersetzen - das faellt auf, sobald mehrere Gruppen eine
// gemeinsame Instanz nutzen oder sich ein Bedienpasswort herumspricht.
// Die Anmeldung dafuer liegt HINTER dem normalen Zugriffsschutz: Admin
// koennen nur Leute werden, die ohnehin schon hereindurften.
const ADMIN_TOKEN = process.env.CUELIGHT_ADMIN_PASSWORD || '';
const ADMIN_COOKIE = ADMIN_TOKEN
  ? crypto.createHmac('sha256', ADMIN_TOKEN).update('cl_admin.v1').digest('base64url')
  : '';

// Content-Security-Policy: standardmaessig AUS. Sie kann das Zoom-SDK
// blockieren (WebAssembly, Worker, Medien-Verbindungen zu wechselnden
// Zoom-Hosts), und ein Schutzmechanismus, der die Anzeige mitten in einer
// Veranstaltung lahmlegt, richtet mehr Schaden an, als er verhindert.
// Wer sie will, setzt CUELIGHT_ENABLE_CSP=1 und testet einmal einen
// kompletten Beitritt damit.
const ENABLE_CSP = process.env.CUELIGHT_ENABLE_CSP === '1';

// Die Selbstpruefung laeuft ganz unten, direkt vor app.listen - dort ist
// bekannt, ob das Datenverzeichnis beschreibbar ist und ob schon eine
// Freigabe vorliegt. Beides braucht die Pruefung, und beides steht hier
// oben noch nicht fest.

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
    const roh = part.slice(idx + 1).trim();
    // decodeURIComponent wirft bei einem kaputten Cookie ("cl_access=%").
    // Ungefangen passierte das mitten in der Zugriffspruefung - der
    // betroffene Browser bekaeme dann auf JEDER Seite einen Serverfehler
    // und kaeme ohne Loeschen der Cookies nicht mehr herein. Im Zweifel
    // lieber den Rohwert nehmen: der passt dann eben nicht, und der Nutzer
    // landet ganz normal auf der Anmeldeseite.
    let wert;
    try {
      wert = decodeURIComponent(roh);
    } catch {
      wert = roh;
    }
    out[part.slice(0, idx).trim()] = wert;
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

// Alles, was aus einer Anfrage oder von Zoom kommt und in einer HTML-Seite
// landet, muss hier durch. Express schickt res.send(<string>) mit
// Content-Type text/html - ein ungefilterter Wert waere damit ausfuehrbares
// Markup auf genau der Origin, auf der auch der Geraetespeicher mit den
// Meeting-Zugangsdaten liegt.
function escapeHtml(wert) {
  return String(wert)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
function rateLimit({ max, windowMs, name }) {
  return (req, res, next) => {
    // Getrennter Zaehler je Route: mit einem gemeinsamen Zaehler pro IP
    // haetten normale Board-Anfragen die Anmeldeseite mitblockiert - man
    // koennte sich also durch blosse Nutzung selbst aussperren.
    const key = `${name}|${req.ip || 'unknown'}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      if ((req.get('accept') || '').includes('text/html')) {
        return res
          .status(429)
          .type('text/plain; charset=utf-8')
          .send('Zu viele Versuche. Bitte eine Minute warten.');
      }
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
// Beim Bauen des Images setzt der Workflow CUELIGHT_VERSION auf den
// Git-Tag - dann stimmt die Anzeige auch ohne Handarbeit in package.json.
const VERSION = process.env.CUELIGHT_VERSION || PACKAGE_VERSION;

// Bewusst ohne Versionsnummer: Diese Route liegt VOR der Zugriffspruefung,
// ein unangemeldeter Aufruf verriete sonst die genau laufende Fassung. Der
// Docker-Healthcheck prueft ohnehin nur, ob geantwortet wird. Die Version
// steht weiterhin unter /api/version - hinter dem Passwort.
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (isSecure(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  if (ENABLE_CSP) {
    // 'unsafe-inline'/'unsafe-eval' sind noetig: die App ist ein einzelnes
    // HTML mit Inline-Skript, und das Zoom-SDK laedt WebAssembly nach.
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://source.zoom.us",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: mediastream: https://*.zoom.us",
        "frame-src 'self' blob:",
        "font-src 'self' data:",
        "connect-src 'self' https://*.zoom.us wss://*.zoom.us",
        // Das Zoom-SDK laedt seine Web Worker direkt von source.zoom.us -
        // fehlt der Eintrag hier, schlaegt der Beitritt fehl.
        "worker-src 'self' blob: https://source.zoom.us",
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
function unlockPage({ wrong = false, admin = false } = {}) {
  const ziel = admin ? '/unlock-admin' : '/unlock';
  const einleitung = admin
    ? 'Die Zoom-Freigabe dieser Instanz aendern. Dafuer gilt das Admin-Passwort aus der docker-compose.yml, nicht das Passwort der Seite.'
    : 'Einmal pro Gerät das Passwort eintragen. Danach merkt sich der Browser die Freigabe.';
  const fehler = admin
    ? 'Admin-Passwort stimmt nicht. Es ist der Wert, der in der docker-compose.yml bei CUELIGHT_ADMIN_PASSWORD steht.'
    : 'Passwort stimmt nicht. Es ist der Wert, der in der docker-compose.yml bei CUELIGHT_PASSWORD steht.';
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
<form method="POST" action="${ziel}">
  <h1>CueLight${admin ? ' · Admin' : ''}</h1>
  <p>${einleitung}</p>
  <input type="password" name="key" autocomplete="current-password"
         autofocus placeholder="Passwort" />
  <button type="submit">Anmelden</button>
  ${wrong ? `<p class="err">${fehler}</p>` : ''}
</form></body></html>`;
}

app.get('/unlock', (req, res) => {
  if (!ACCESS_TOKEN) return res.redirect('/');
  res.type('html').send(unlockPage());
});

app.post(
  '/unlock',
  express.urlencoded({ extended: false, limit: '2kb' }),
  rateLimit({ name: 'unlock', max: 10, windowMs: 60_000 }),
  (req, res) => {
    if (!ACCESS_TOKEN) return res.redirect('/');
    const key = String((req.body && req.body.key) || '').trim();
    if (safeEqual(key, ACCESS_TOKEN)) {
      setCookie(res, 'cl_access', ACCESS_COOKIE, {
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
  if (safeEqual(cookies.cl_access || '', ACCESS_COOKIE)) return next();

  // Kein Passwort per ?k= in der Adresse: Das landet im Browser-Verlauf,
  // in Proxy-Protokollen und auf Screenshots. Angemeldet wird sich ueber
  // die Seite /unlock, das Ergebnis merkt sich der Browser.

  // Normaler Seitenaufruf -> Entsperr-Formular. API-Aufrufe bekommen
  // weiterhin eine kurze, maschinenlesbare Antwort.
  const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
  if (wantsHtml) return res.redirect('/unlock');
  res.status(401).json({ error: 'locked', message: 'Passwort fehlt.' });
});

// --- Admin-Anmeldung (nur wenn CUELIGHT_ADMIN_PASSWORD gesetzt ist) -----
// Steht bewusst NACH der Zugriffspruefung oben: wer das Bedienpasswort
// nicht hat, bekommt dieses Formular gar nicht erst zu sehen und kann das
// Admin-Passwort auch nicht durchprobieren.
app.get('/unlock-admin', (req, res) => {
  if (!ADMIN_TOKEN) return res.redirect('/');
  res.type('html').send(unlockPage({ admin: true }));
});

app.post(
  '/unlock-admin',
  express.urlencoded({ extended: false, limit: '2kb' }),
  rateLimit({ name: 'unlock-admin', max: 10, windowMs: 60_000 }),
  (req, res) => {
    if (!ADMIN_TOKEN) return res.redirect('/');
    const key = String((req.body && req.body.key) || '').trim();
    if (safeEqual(key, ADMIN_TOKEN)) {
      // Kurzlebiger als die Bedienfreigabe: Admin ist man fuer die Dauer
      // einer Einrichtung, nicht dauerhaft.
      setCookie(res, 'cl_admin', ADMIN_COOKIE, {
        maxAge: 60 * 60 * 2,
        secure: isSecure(req),
      });
      return res.redirect('/oauth/authorize');
    }
    res.status(401).type('html').send(unlockPage({ wrong: true, admin: true }));
  }
);

// Vor die beiden Endpunkte gehaengt, die entscheiden, in wessen Namen diese
// Instanz Meetings beitritt. Ohne gesetztes Admin-Passwort faellt die
// Pruefung weg - bestehende Installationen aendern ihr Verhalten also nicht.
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (safeEqual(parseCookies(req).cl_admin || '', ADMIN_COOKIE)) return next();
  const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
  if (wantsHtml) return res.redirect('/unlock-admin');
  res.status(403).json({ error: 'admin_required', message: 'Admin-Passwort fehlt.' });
}

app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Bewusst OHNE Exit: Seit Node 15 beendet ein unbehandeltes Promise den
// Prozess von selbst - dieser Handler unterdrueckt das absichtlich. Eine
// fehlgeschlagene Zoom-Anfrage darf die Anzeige nicht mitten in der
// Veranstaltung abschiessen; der geloggte Fehler ist das kleinere Uebel.
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

// Hier dagegen bewusst MIT Exit: ein Prozess in undefiniertem Zustand ist
// gefaehrlicher als ein Neustart, den Docker dank "restart: unless-stopped"
// in unter einer Sekunde erledigt.
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
  // Zufaelliger Name statt eines festen: Eine aus einem Absturz liegen
  // gebliebene .tmp wuerde sonst wiederbeschrieben - und writeFileSync setzt
  // "mode" nur beim ANLEGEN, die alte Datei behielte also ihre Rechte und
  // wuerde per rename zur echten Token-Datei befoerdert.
  const tmp = `${TOKEN_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, TOKEN_FILE);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* war nie da oder schon weg */
    }
    throw err;
  }
}

function clearTokens() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {
    /* war schon weg */
  }
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
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
  // Zoom rotiert das Refresh-Token normalerweise bei jedem Einloesen.
  // Bleibt das Feld aber einmal leer, wuerde "undefined" gespeichert - und
  // ab dann liesse sich die Freigabe nie wieder erneuern, obwohl das alte
  // Token noch gueltig waere. Deshalb im Zweifel das bisherige behalten.
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: ablaufZeitpunkt(fresh.expires_in),
  };
  saveTokens(updated);
  return updated.access_token;
}

// --- 1) Meeting-Host startet hier die einmalige Freigabe -----------------
app.get('/oauth/authorize', requireAdmin, (req, res) => {
  if (!CLIENT_ID) {
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
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', `${baseUrl(req)}/oauth/callback`);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// --- 2) Zoom schickt den Host hierher zurueck -----------------------------
app.get('/oauth/callback', async (req, res) => {
  const { code, error, state } = req.query;

  // Der CSRF-Schutz steht bewusst GANZ vorne. Frueher wurde ein
  // error-Parameter aus der Adresse noch vor dieser Pruefung in die Antwort
  // gespiegelt - wer jemanden auf /oauth/callback?error=<markup> lockte,
  // bekam seinen Code auf dieser Origin ausgefuehrt, und das Passwort der
  // Seite half nicht: der angemeldete Bediener bringt sein Cookie selbst
  // mit. Ohne gueltigen state kommt jetzt gar nichts mehr zurueck, und alle
  // Antworten hier sind reiner Text statt HTML.
  const expectedState = parseCookies(req).cl_oauth_state || '';
  if (!expectedState || !safeEqual(String(state || ''), expectedState)) {
    return res
      .status(400)
      .type('text/plain; charset=utf-8')
      .send('Ungueltige oder abgelaufene Freigabe-Anfrage. Bitte erneut ueber /oauth/authorize starten.');
  }
  setCookie(res, 'cl_oauth_state', '', { maxAge: 0, path: '/oauth', secure: isSecure(req) });

  if (error) {
    return res
      .status(400)
      .type('text/plain; charset=utf-8')
      .send(`Zoom hat die Freigabe abgelehnt: ${error}`);
  }
  if (!code) {
    return res.status(400).type('text/plain; charset=utf-8').send('Kein code von Zoom erhalten.');
  }

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
      } else {
        // Frueher stumm - und genau das war das Problem: ohne Log gab es
        // keinen Hinweis darauf, dass die Bindung gleich uebersprungen wird.
        console.error('Kontodaten nicht abrufbar:', meRes.status, await meRes.text());
      }
    } catch (err) {
      console.warn('Konnte Kontodaten nicht abrufen:', err);
    }

    // Ohne verifiziertes Konto wird NICHTS gespeichert. Vorher lief es
    // andersherum: blieb account leer, uebersprang die Pruefung unten mangels
    // account_id den Vergleich - und eine bestehende Bindung liess sich
    // umgehen, indem man den Abruf scheitern liess. Lieber ein ehrlicher
    // Fehlschlag als eine Freigabe, von der niemand weiss, wem sie gehoert.
    if (!account.account_id) {
      return res
        .status(502)
        .type('text/plain; charset=utf-8')
        .send(
          'Zoom-Konto konnte nicht ueberprueft werden, die Freigabe wurde ' +
          'deshalb nicht gespeichert. Bitte spaeter erneut versuchen.'
        );
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
        .type('text/plain; charset=utf-8')
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
      expires_at: ablaufZeitpunkt(data.expires_in),
      account,
      authorized_at: new Date().toISOString(),
    });

    // Die Kontodaten stammen aus Zooms Antwort, nicht aus eigener Hand -
    // also auch hier durch escapeHtml, bevor sie in die Seite gehen.
    res.type('html').send(
      '<h1>Freigabe erfolgreich</h1>' +
      `<p>CueLight darf jetzt im Namen von ${escapeHtml(account.email || 'diesem Konto')} ` +
      'Meetings beitreten. Du kannst dieses Fenster schliessen.</p>'
    );
  } catch (err) {
    console.error('Fehler in /oauth/callback:', err);
    res.status(500).send('Unerwarteter Fehler beim Verarbeiten der Zoom-Freigabe, siehe Server-Log.');
  }
});

// Wird im Einrichtungsformular klein unten angezeigt - damit bei einer
// Fehlermeldung sofort klar ist, welche Fassung laeuft.
app.get('/api/version', (req, res) => res.json({ version: VERSION }));

// Zoom-Freigabe zuruecksetzen, damit ein anderes Konto autorisieren kann.
// Vorher musste man dafuer data/zoom-oauth-tokens.json im Volume loeschen -
// fuer jemanden, der nur Docker bedient, eine unnoetige Huerde.
// Mit Mengenlimit: der Endpunkt wirft die Freigabe des Hosts weg, und ohne
// gesetztes CUELIGHT_PASSWORD liegt er voellig offen. Ein versehentlich
// oder boeswillig wiederholter Aufruf soll nicht mitten in der
// Veranstaltung die Autorisierung kosten.
app.post('/oauth/reset', requireAdmin, rateLimit({ name: 'reset', max: 5, windowMs: 60_000 }), (req, res) => {
  clearTokens();
  console.log('Zoom-Freigabe zurueckgesetzt.');
  res.json({ ok: true });
});

// Fuer die Anzeige im Board: ist der Host schon einmalig freigegeben?
app.get('/oauth/status', async (req, res) => {
  const tokens = loadTokens();
  if (!tokens) return res.json({ authorized: false, account: null });

  // Bewusst nicht nur pruefen, ob die Datei da ist: Zoom laesst
  // Refresh-Tokens nach laengerer Nichtnutzung verfallen. Sonst sieht das
  // Formular am Veranstaltungstag gruen aus, und erst der Beitritt
  // scheitert. Der Aufruf erneuert das Token nebenbei, hält es also
  // frisch, sooft jemand die Seite oeffnet.
  const account = tokens.account ? tokens.account.email || null : null;

  try {
    const accessToken = await getValidAccessToken();
    res.json({ authorized: !!accessToken, account });
  } catch (err) {
    // Zoom nicht erreichbar (DNS, Zeitlimit, Netz zuckt): Das ist KEIN
    // Beweis, dass die Freigabe weg ist - es ist Unwissen. Also auf die
    // gespeicherte Freigabe zurueckfallen, statt den Freigabe-Knopf zu
    // zeigen und jemanden mitten in der Veranstaltung zu einer neuen
    // Autorisierung zu schicken. Ohne diesen Block bliebe die Anfrage
    // ausserdem unbeantwortet, und der Browser wartet bis zum eigenen
    // Zeitlimit.
    console.error('Freigabe-Status nicht pruefbar:', err);
    res.json({ authorized: true, account, unverified: true });
  }
});

// --- 3) OBF-Token fuer den eigentlichen Beitritt --------------------------
// GET /api/obf-token?meetingNumber=123456789
// Achtung: gibt ein Token heraus, das gegenueber Zoom im Namen des
// autorisierten Hosts wirkt - deshalb liegt der Endpunkt hinter dem
// Zugriffsschluessel oben und hinter einem Mengenlimit.
app.get('/api/obf-token', rateLimit({ name: 'obf', max: 30, windowMs: 60_000 }), async (req, res) => {
  try {
    // Die Eingabe zuerst: Hart ablehnen statt stillschweigend weglassen.
    // Frueher ging die Anfrage bei einer unsinnigen Nummer trotzdem raus -
    // nur eben ohne meeting_id, und dann liefert Zoom ein Token, das an gar
    // kein Meeting gebunden ist. Ein Endpunkt, der im Namen des Hosts
    // wirkt, soll nichts Weitergehendes ausstellen als das, wonach gefragt
    // wurde. Vor der Freigabe-Pruefung, damit eine kaputte Anfrage nicht
    // erst noch einen Token-Refresh bei Zoom ausloest.
    const meetingNumber = String(req.query.meetingNumber || '');
    if (!/^\d{9,12}$/.test(meetingNumber)) {
      return res.status(400).json({ error: 'meetingNumber ungueltig (9-12 Ziffern erwartet)' });
    }

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      return res.status(401).json({
        error: 'not_authorized',
        message: 'Der Meeting-Host hat die App noch nicht freigegeben. Bitte /oauth/authorize aufrufen.',
      });
    }

    const url = new URL('https://api.zoom.us/v2/users/me/token');
    url.searchParams.set('type', 'onbehalf');
    url.searchParams.set('meeting_id', meetingNumber);

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
app.post('/api/signature', rateLimit({ name: 'signature', max: 60, windowMs: 60_000 }), (req, res) => {
  const { meetingNumber } = req.body || {};

  if (!/^\d{9,12}$/.test(String(meetingNumber || ''))) {
    return res.status(400).json({ error: 'meetingNumber ungueltig (9-12 Ziffern erwartet)' });
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({
      error: 'Server nicht konfiguriert: ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET fehlen',
    });
  }

  const iat = Math.floor(Date.now() / 1000) - 30; // 30s Puffer gegen Uhr-Drift
  // Zoom erlaubt bis 48 Stunden. Zwei waren knapp: Bei einer
  // Verbindungsstoerung versucht das SDK den Wiedereinstieg mit derselben
  // Signatur - nach einer langen Veranstaltung koennte die abgelaufen sein.
  // Ausgegeben wird sie ohnehin nur hinter dem Passwort.
  const exp = iat + 60 * 60 * 12;

  const payload = {
    appKey: CLIENT_ID,
    sdkKey: CLIENT_ID,
    mn: String(meetingNumber),
    role: 0,
    iat,
    exp,
    tokenExp: exp,
  };

  const signature = jwt.sign(payload, CLIENT_SECRET, { algorithm: 'HS256' });
  res.json({ signature });
});

// --- Selbstpruefung beim Start ------------------------------------------
//
// Sie bricht NICHTS ab. CueLight steht in einem Saal und soll laufen; ein
// Dienst, der wegen einer fehlenden Angabe gar nicht erst startet, zeigt
// auf dem Pult einen Browserfehler statt einer Seite, die sagt, was zu
// tun ist. Gemeldet wird deutlich, beendet wird nicht.
function datenOrdnerBeschreibbar() {
  const ordner = path.dirname(TOKEN_FILE);
  try {
    fs.mkdirSync(ordner, { recursive: true, mode: 0o700 });
    // Wirklich schreiben statt nur fragen: fs.accessSync sagt bei einem
    // gemounteten Verzeichnis mit fremden Rechten schon einmal "geht",
    // und beim ersten echten Schreibversuch kommt dann EACCES.
    const probe = path.join(ordner, `.schreibprobe.${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

console.log(
  berichtAlsText(
    selbstpruefung(process.env, {
      datenOrdnerBeschreibbar: datenOrdnerBeschreibbar(),
      freigabeVorhanden: Boolean(loadTokens()),
    })
  )
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Signature-Server laeuft auf http://localhost:${PORT}`);
  console.log(`Board oeffnen unter http://localhost:${PORT}/`);
});
