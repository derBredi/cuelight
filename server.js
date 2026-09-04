// server.js
// Zwei Aufgaben:
// 1) Eine gueltige Meeting-SDK-Signatur (JWT) ausstellen, damit das Board
//    sich als Teilnehmer in ein Meeting einklinken darf.
// 2) Seit Zooms Attributions-Pflicht (2. Maerz 2026) zusaetzlich ein
//    "On Behalf Of"-Token (OBF) besorgen, wenn die App in einem ANDEREN
//    Zoom-Account erstellt wurde als dem, der das Meeting hostet. Dafuer
//    muss der Meeting-Host die App einmalig per OAuth freigeben.
// Alle Zugangsdaten bleiben serverseitig, nie im Browser sichtbar.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Sicherheitsnetz: ein einzelner unerwarteter Fehler (z. B. Zoom-API kurz
// nicht erreichbar) soll waehrend der Veranstaltung nicht den ganzen
// Server abschiessen. Node wuerde sonst standardmaessig den Prozess
// beenden, was den Container abstuerzen laesst (502 beim naechsten Aufruf).
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

// --- SDK-Zugangsdaten (fuer die Signatur / den Beitritt selbst) ---------
const SDK_KEY = process.env.ZOOM_MEETING_SDK_KEY;
const SDK_SECRET = process.env.ZOOM_MEETING_SDK_SECRET;

// --- OAuth-Zugangsdaten (fuer die einmalige Freigabe durch den Host) ----
const OAUTH_CLIENT_ID = process.env.ZOOM_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.ZOOM_OAUTH_CLIENT_SECRET;
// Oeffentlich erreichbare Basis-URL, z. B. https://meldungen.deine-domain.de
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

if (!SDK_KEY || !SDK_SECRET) {
  console.warn(
    '[Achtung] ZOOM_MEETING_SDK_KEY / ZOOM_MEETING_SDK_SECRET fehlen. ' +
    'Bitte in docker-compose.yml unter "environment:" eintragen.'
  );
}
if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !APP_BASE_URL) {
  console.warn(
    '[Achtung] ZOOM_OAUTH_CLIENT_ID / ZOOM_OAUTH_CLIENT_SECRET / APP_BASE_URL ' +
    'fehlen. Ohne diese kann der Meeting-Host die App nicht per OAuth freigeben ' +
    '(noetig, weil App-Account und Meeting-Host-Account unterschiedlich sind).'
  );
}

// -------------------------------------------------------------------
// Token-Speicher: die OAuth-Tokens des Hosts landen in einer kleinen
// JSON-Datei auf einem Docker-Volume, damit sie einen Container-Neustart
// ueberleben und der Host die Freigabe nicht bei jedem Deploy wiederholen muss.
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
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64');
}

// Liefert ein gueltiges Access-Token des Hosts, erneuert es bei Bedarf
// automatisch ueber das Refresh-Token.
async function getValidAccessToken() {
  const tokens = loadTokens();
  if (!tokens) return null;

  const stillValid = tokens.expires_at && Date.now() < tokens.expires_at - 60_000;
  if (stillValid) return tokens.access_token;

  // Access-Token abgelaufen (oder laeuft gleich ab) -> erneuern
  const res = await fetch('https://zoom.us/oauth/token', {
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
    console.error('Konnte Zoom-Token nicht erneuern:', await res.text());
    return null;
  }

  const fresh = await res.json();
  const updated = {
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
  const redirectUri = `${APP_BASE_URL}/oauth/callback`;
  const url = new URL('https://zoom.us/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  res.redirect(url.toString());
});

// --- 2) Zoom schickt den Host hierher zurueck -----------------------------
app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Zoom hat die Freigabe abgelehnt: ${error}`);
  if (!code) return res.status(400).send('Kein code von Zoom erhalten.');

  try {
    const redirectUri = `${APP_BASE_URL}/oauth/callback`;
    const tokenRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      console.error('Token-Austausch fehlgeschlagen:', await tokenRes.text());
      return res.status(500).send('Token-Austausch mit Zoom fehlgeschlagen, siehe Server-Log.');
    }

    const data = await tokenRes.json();
    saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    });

    res.send(
      '<h1>Freigabe erfolgreich</h1>' +
      '<p>Das Meldungen-Board darf jetzt in deinem Namen Meetings beitreten. ' +
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
  res.json({ authorized: !!tokens });
});

// --- 3) OBF-Token fuer den eigentlichen Beitritt --------------------------
// GET /api/obf-token?meetingNumber=123456789
app.get('/api/obf-token', async (req, res) => {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      return res.status(401).json({
        error: 'not_authorized',
        message: 'Der Meeting-Host hat die App noch nicht freigegeben. Bitte /oauth/authorize aufrufen.',
      });
    }

    const { meetingNumber } = req.query;
    const url = new URL('https://api.zoom.us/v2/users/me/token');
    url.searchParams.set('type', 'onbehalf');
    if (meetingNumber) url.searchParams.set('meeting_id', String(meetingNumber));

    const obfRes = await fetch(url, {
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

// POST /api/signature   Body: { meetingNumber: "123456789", role: 0 }
// role: 0 = Teilnehmer (reicht zum Zuhoeren/Beobachten), 1 = Host
app.post('/api/signature', (req, res) => {
  const { meetingNumber, role = 0 } = req.body || {};

  if (!meetingNumber) {
    return res.status(400).json({ error: 'meetingNumber fehlt' });
  }
  if (!SDK_KEY || !SDK_SECRET) {
    return res.status(500).json({ error: 'Server nicht konfiguriert (siehe docker-compose.yml)' });
  }

  const iat = Math.floor(Date.now() / 1000) - 30; // 30s Puffer gegen Uhr-Drift
  const exp = iat + 60 * 60 * 2; // 2 Stunden Gueltigkeit

  const payload = {
    appKey: SDK_KEY,
    sdkKey: SDK_KEY,
    mn: String(meetingNumber),
    role: Number(role),
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
  console.log(`Board oeffnen unter http://localhost:${PORT}/index.html`);
});
