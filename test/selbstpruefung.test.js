'use strict';

// Prueft die Selbstpruefung.
//
// WARUM DAS NICHT ZU VIEL DES GUTEN IST: Diese Hinweise sind das Erste,
// was ein Selbsthoster von CueLight zu sehen bekommt, wenn etwas fehlt.
// Sagt einer davon das Falsche - oder bleibt einer aus -, sucht jemand
// an der falschen Stelle. Das kostet mehr Zeit als dieser Test je
// einsparen koennte.

const test = require('node:test');
const assert = require('node:assert');

const { selbstpruefung, berichtAlsText } = require('../lib/selbstpruefung');

/** Eine vollstaendig eingerichtete Instanz. */
const VOLLSTAENDIG = {
  ZOOM_CLIENT_ID: 'abc',
  ZOOM_CLIENT_SECRET: 'geheim',
  CUELIGHT_PASSWORD: 'saal',
  CUELIGHT_ADMIN_PASSWORD: 'admin',
};

const stufen = (befunde, stufe) => befunde.filter((b) => b.stufe === stufe);

test('vollstaendig eingerichtet: nichts Dringendes offen', () => {
  const befunde = selbstpruefung(VOLLSTAENDIG, {
    datenOrdnerBeschreibbar: true,
    freigabeVorhanden: true,
  });
  assert.deepStrictEqual(stufen(befunde, 'fehlt'), []);
  assert.deepStrictEqual(stufen(befunde, 'hinweis'), []);
});

test('ohne Zugangsdaten wird das als FEHLEND gemeldet, nicht als Hinweis', () => {
  const befunde = selbstpruefung({}, {});
  const fehlt = stufen(befunde, 'fehlt');
  assert.strictEqual(fehlt.length, 1);
  assert.match(fehlt[0].satz, /ZOOM_CLIENT_ID und ZOOM_CLIENT_SECRET/);
});

test('fehlt nur eines der beiden, steht auch nur dieses im Satz', () => {
  const befunde = selbstpruefung({ ZOOM_CLIENT_ID: 'abc' }, {});
  const fehlt = stufen(befunde, 'fehlt')[0];
  assert.match(fehlt.satz, /ZOOM_CLIENT_SECRET fehlt/);
  assert.ok(
    !fehlt.satz.includes('ZOOM_CLIENT_ID und'),
    'die gesetzte Angabe darf nicht mitbeanstandet werden'
  );
});

test('Leerzeichen zaehlen nicht als gesetzt', () => {
  // Eine Umgebungsvariable, die versehentlich nur ein Leerzeichen
  // enthaelt, sieht in der Compose-Datei aus wie ein Wert - ist aber
  // keiner. Ohne diese Pruefung meldete die Selbstpruefung "ok" und der
  // Beitritt scheiterte spaeter ohne erkennbaren Grund.
  const befunde = selbstpruefung({ ZOOM_CLIENT_ID: '  ', ZOOM_CLIENT_SECRET: 'x' }, {});
  assert.strictEqual(stufen(befunde, 'fehlt').length, 1);
});

test('ein nicht beschreibbares Datenverzeichnis ist ein FEHLER, kein Hinweis', () => {
  // Das ist der heimtueckischste Fall: Einrichten klappt, die Freigabe
  // wird erteilt, alles sieht gut aus - und nach dem naechsten Neustart
  // ist sie weg. Deshalb dieselbe Stufe wie fehlende Zugangsdaten.
  const befunde = selbstpruefung(VOLLSTAENDIG, {
    datenOrdnerBeschreibbar: false,
    freigabeVorhanden: true,
  });
  const fehlt = stufen(befunde, 'fehlt');
  assert.strictEqual(fehlt.length, 1);
  assert.match(fehlt[0].satz, /chown/);
});

test('ohne Passwort gibt es einen Hinweis, aber keinen Fehler', () => {
  const ohne = { ...VOLLSTAENDIG, CUELIGHT_PASSWORD: '' };
  const befunde = selbstpruefung(ohne, { datenOrdnerBeschreibbar: true, freigabeVorhanden: true });
  assert.deepStrictEqual(stufen(befunde, 'fehlt'), []);
  assert.strictEqual(stufen(befunde, 'hinweis').length, 1);
});

test('noch keine Freigabe erteilt: Hinweis mit dem naechsten Schritt', () => {
  const befunde = selbstpruefung(VOLLSTAENDIG, {
    datenOrdnerBeschreibbar: true,
    freigabeVorhanden: false,
  });
  const hinweis = stufen(befunde, 'hinweis')[0];
  assert.match(hinweis.satz, /oauth\/authorize/);
});

test('jeder Befund hat Stufe, Gegenstand und einen ganzen Satz', () => {
  // Eine Meldung ohne Satz ist eine Meldung, die niemandem hilft.
  for (const lage of [{}, VOLLSTAENDIG, { ZOOM_CLIENT_ID: 'a' }]) {
    for (const b of selbstpruefung(lage, { datenOrdnerBeschreibbar: false, freigabeVorhanden: false })) {
      assert.ok(['fehlt', 'hinweis', 'gut'].includes(b.stufe), `unbekannte Stufe: ${b.stufe}`);
      assert.ok(b.was && b.was.length > 2, 'Gegenstand fehlt');
      assert.ok(b.satz && b.satz.length > 20, `zu knapper Satz: ${b.satz}`);
      assert.ok(b.satz.trim().endsWith('.'), `kein ganzer Satz: ${b.satz}`);
    }
  }
});

test('der Bericht stellt das Dringende nach oben', () => {
  const text = berichtAlsText(selbstpruefung({}, { datenOrdnerBeschreibbar: false }));
  const zeilen = text.split('\n').filter((z) => z.startsWith('['));
  assert.ok(zeilen[0].startsWith('[FEHLT'), `oben stand: ${zeilen[0]}`);
  assert.match(text, /muessen erledigt werden/);
});

test('ist alles in Ordnung, sagt der Bericht das auch', () => {
  const text = berichtAlsText(
    selbstpruefung(VOLLSTAENDIG, { datenOrdnerBeschreibbar: true, freigabeVorhanden: true })
  );
  assert.match(text, /Nichts Dringendes offen/);
});
