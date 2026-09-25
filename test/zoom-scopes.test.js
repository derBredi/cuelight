'use strict';

// Nennt die README dieselben Zoom-Scopes, die der Server wirklich braucht?
//
// WARUM ES DIESEN TEST GIBT: Bis zum 25.09.2026 stand in der README ein
// einziger Scope, `user:read:token`. Der Server ruft aber ZWEI Endpunkte
// bei Zoom auf, und der zweite - GET /v2/users/me - braucht einen eigenen.
// Ohne ihn bricht die Freigabe mit einem 502 ab ("Zoom-Konto konnte nicht
// ueberprueft werden") und wird nicht gespeichert; wer der Anleitung
// folgte, kam also nie ins Meeting und bekam keinen Hinweis darauf, was
// fehlt.
//
// Aufgefallen ist es nur, weil Michael die Angabe angezweifelt hat. Kein
// Test hat sie je beruehrt - Scopes stehen nirgends im Code, sie werden
// in der Zoom-App eingestellt, und der authorize-Aufruf schickt keinen
// scope-Parameter mit.
//
// Deshalb gibt es in server.js jetzt die Liste ZOOM_SCOPES. Sie wird dort
// nicht benutzt; sie ist die Stelle, an der steht, was gebraucht wird -
// und dieser Test haelt sie mit der README zusammen.
//
// WAS ER NICHT KANN: Er fragt Zoom nicht. Ob `user:read:user` bei Zoom
// wirklich so heisst und wirklich fuer /users/me verlangt wird, steht
// hier nicht zur Debatte - das ist belegt und in server.js begruendet.
// Geprueft wird, dass beide Dateien dasselbe sagen und dass die Aufrufe,
// um die es geht, ueberhaupt noch im Server stehen.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WURZEL = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
const README = fs.readFileSync(path.join(WURZEL, 'README.md'), 'utf8');

/** Die Liste ZOOM_SCOPES aus server.js, als Text gelesen. */
function scopesAusDemServer() {
  const treffer = SERVER.match(/const ZOOM_SCOPES = \[([^\]]*)\]/);
  assert.ok(
    treffer,
    'In server.js steht keine Liste ZOOM_SCOPES mehr. Wenn sie umgezogen '
    + 'ist, gehoert dieser Test nachgezogen - und nicht geloescht.'
  );
  return [...treffer[1].matchAll(/'([^']+)'/g)].map((t) => t[1]);
}

test('die Scope-Liste im Server ist nicht leer und sieht aus wie Scopes', () => {
  const scopes = scopesAusDemServer();
  assert.ok(scopes.length >= 2, `nur ${scopes.length} Scope(s) gefunden`);
  for (const s of scopes) {
    assert.match(s, /^[a-z_]+:[a-z_]+:[a-z_]+$/, `"${s}" sieht nicht wie ein Zoom-Scope aus`);
  }
});

test('die README nennt jeden Scope, den der Server braucht', () => {
  const fehlend = scopesAusDemServer().filter((s) => !README.includes(s));
  assert.deepStrictEqual(
    fehlend, [],
    'Diese Scopes braucht der Server, aber die Einrichtungsanleitung nennt '
    + 'sie nicht. Wer ihr folgt, bekommt eine Anwendung, die nicht ins '
    + 'Meeting kommt:\n  ' + fehlend.join('\n  ')
  );
});

test('die README nennt keinen Scope, den der Server nicht braucht', () => {
  // Die Gegenrichtung. Ein Scope zu viel ist kein Ausfall, aber es ist
  // eine Berechtigung, die sich jemand geben laesst, ohne dass sie
  // gebraucht wird - und bei einer Anwendung, deren ganzes
  // Sicherheitsargument "wir nehmen so wenig wie moeglich" lautet, ist das
  // kein Detail.
  const bekannt = new Set(scopesAusDemServer());
  const inReadme = [...README.matchAll(/`(user:[a-z_]+:[a-z_]+)`/g)].map((t) => t[1]);
  const ueberfluessig = [...new Set(inReadme)].filter((s) => !bekannt.has(s));

  assert.deepStrictEqual(
    ueberfluessig, [],
    'Die README verlangt Scopes, die der Server nirgends braucht:\n  '
    + ueberfluessig.join('\n  ')
  );
});

test('die beiden Aufrufe, um die es geht, stehen noch im Server', () => {
  // Ohne das koennte die Liste eines Tages zu einer Anwendung gehoeren,
  // die ganz andere Endpunkte aufruft - und weiterhin gruen leuchten.
  const klagen = [];
  if (!SERVER.includes('api.zoom.us/v2/users/me\'')
    && !SERVER.includes('api.zoom.us/v2/users/me"')) {
    klagen.push('  GET /v2/users/me ruft der Server nicht mehr auf (user:read:user)');
  }
  if (!SERVER.includes('api.zoom.us/v2/users/me/token')) {
    klagen.push('  GET /v2/users/me/token ruft der Server nicht mehr auf (user:read:token)');
  }
  assert.deepStrictEqual(
    klagen, [],
    'Die Scope-Liste passt nicht mehr zu dem, was der Server tut:\n' + klagen.join('\n')
  );
});

test('ohne verifiziertes Konto wird keine Freigabe gespeichert', () => {
  // Das ist der Grund, warum user:read:user kein "nice to have" ist. Faellt
  // diese Wache eines Tages weg, waere der Scope tatsaechlich optional -
  // dann gehoert aber auch die README geaendert, und nicht stillschweigend
  // ein Sicherheitsnetz entfernt.
  assert.match(
    SERVER,
    /if \(!account\.account_id\)\s*\{[\s\S]{0,400}?502/,
    'Die Pruefung "ohne account_id wird nichts gespeichert" steht nicht mehr '
    + 'in server.js. Ohne sie liesse sich eine bestehende Bindung umgehen, '
    + 'indem man den Kontoabruf scheitern laesst.'
  );
});
