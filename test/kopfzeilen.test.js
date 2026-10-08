'use strict';
// Schickt CueLight die Kopfzeilen, die es schicken soll?
//
// WARUM ES DIESEN TEST GIBT: server.js setzt seit laengerem
// X-Content-Type-Options, Referrer-Policy, X-Frame-Options und HSTS -
// und kein Test hat je hingesehen. Eine Kopfzeile, die jemand beim
// Umbauen verliert, faellt sonst niemandem auf: Die Seite laedt weiter,
// sie ist nur weniger geschuetzt.
//
// GEPRUEFT WIRD DER TEXT VON server.js und nicht eine echte Antwort.
// Dafuer muesste der Server starten, und dafuer muesste server.js seine
// App herausreichen - eine Aenderung an der Anwendung, nur damit ein Test
// bequemer wird. Dasselbe Verfahren benutzt das Geschwisterprojekt fuer
// seine nginx-Konfiguration.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');

const lies = () => fs.readFileSync(SERVER, 'utf8');

/**
 * Nur die Anweisungen, ohne die Kommentare.
 *
 * Noetig, weil die Begruendungen in server.js die Kopfzeilen beim Namen
 * nennen - ein Test, der nach Abwesenheit sucht, faende sie sonst im
 * Text, der erklaert, warum sie fehlen.
 *
 * Zeilenweise und an beiden Arten Zeilenende getrennt: Auf einem
 * Windows-Auscheck haengt an jeder Zeile ein Wagenruecklauf.
 */
function nurAnweisungen(text) {
  return text
    .split(/\r?\n/)
    .filter((z) => !z.trimStart().startsWith('//'))
    .join('\n');
}

test('die Kopfzeilen, die es schon gab, sind noch da', () => {
  const anweisungen = nurAnweisungen(lies());

  for (const kopf of [
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
    'Strict-Transport-Security',
  ]) {
    assert.ok(
      anweisungen.includes(kopf),
      `${kopf} wird nicht mehr gesetzt`
    );
  }
});

test('Mikrofon und Kamera sind gesperrt', () => {
  // DER FALL, GEGEN DEN DAS STEHT, und er ist im Geschwisterprojekt
  // wirklich passiert: Am 04.10.2026 war dort das Tablet in einer echten
  // Zusammenkunft mit Ton eingewaehlt, obwohl "isSupportAV: false"
  // gesetzt war. Die Option hatte in SDK 6.2.0 gewirkt und in 6.5.0 nicht
  // mehr.
  //
  // CueLight laeuft auf 6.2.0, hat die Option also auf seiner Seite. Aber
  // sie ist eine Bitte an eine fremde Bibliothek, die sich
  // vierteljaehrlich aendert - und beim naechsten Umstieg waere der
  // Vorfall hier zu wiederholen. Diese Kopfzeile ist keine Bitte: Sie
  // wirkt im Browser, egal was das SDK vorhat.
  //
  // Die leere Klammer heisst "fuer niemanden, auch nicht fuer uns
  // selbst". Der Browser fragt dann gar nicht erst nach Erlaubnis.
  const anweisungen = nurAnweisungen(lies());

  assert.ok(
    anweisungen.includes('Permissions-Policy'),
    'CueLight schickt keine Permissions-Policy - der Ton haengt damit ' +
    'allein an einer Option des Zoom-SDK'
  );

  for (const sperre of ['microphone=()', 'camera=()', 'display-capture=()']) {
    assert.ok(
      anweisungen.includes(sperre),
      `${sperre} fehlt in der Permissions-Policy`
    );
  }
});

test('der Riegel haengt nicht am CSP-Schalter', () => {
  // DAS IST DER EIGENTLICHE PUNKT DIESES TESTS.
  //
  // Die Content-Security-Policy steht hinter CUELIGHT_ENABLE_CSP, und das
  // ist voreingestellt AUS - mit gutem Grund: CueLight soll sich von
  // anderen einrichten lassen, und eine Regel, die eine fremde
  // Zoom-Fassung lahmlegt, waere ein Supportfall.
  //
  // Die Permissions-Policy darf dort nicht mithineinrutschen. Sie kann
  // nichts lahmlegen - sie verbietet nur etwas, das diese Anwendung nie
  // braucht - und sie ist genau dann noetig, wenn niemand etwas
  // eingestellt hat.
  const zeilen = lies().split(/\r?\n/);

  const istPermissions = (z) => z.includes('Permissions-Policy');
  const i = zeilen.findIndex(istPermissions);
  assert.ok(i > -1, 'Permissions-Policy steht gar nicht in server.js');

  // Von dort nach oben: Steht ein "if (ENABLE_CSP)" dazwischen, ohne dass
  // der Block davor geschlossen wurde?
  let tiefe = 0;
  for (let k = i; k >= 0; k -= 1) {
    const z = zeilen[k];
    if (k !== i) {
      tiefe += (z.match(/\}/g) || []).length;
      tiefe -= (z.match(/\{/g) || []).length;
    }
    if (/if \(ENABLE_CSP\)/.test(z) && tiefe < 0) {
      assert.fail(
        'Die Permissions-Policy steht innerhalb von "if (ENABLE_CSP)".\n' +
        'Der Schalter ist voreingestellt aus - damit waere der Riegel bei ' +
        'jeder Standardeinrichtung weg, und das ist genau die, um die es geht.'
      );
    }
  }
});
