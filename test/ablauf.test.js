'use strict';

// Der erste Test dieses Projekts.
//
// WARUM AUSGERECHNET HIER: Der Rauchtest in der CI prueft, dass der Dienst
// antwortet und dass Passwoerter wirken - beides wichtig, beides an der
// Oberflaeche. Er kann aber nicht sehen, ob eine Rechnung im Inneren
// stimmt. Genau dort sass der Fehler: Ein Token, dessen Ablaufzeitpunkt
// still zu null wird, sieht von aussen aus wie ein gesunder Dienst.
//
// Ausgefuehrt mit "npm test" (node --test), ohne zusaetzliche Pakete.

const test = require('node:test');
const assert = require('node:assert');

const { ablaufZeitpunkt, STANDARD_LEBENSDAUER_SEKUNDEN } = require('../lib/ablauf');

const JETZT = 1_700_000_000_000;

test('eine gewoehnliche Angabe von Zoom wird uebernommen', () => {
  assert.strictEqual(ablaufZeitpunkt(3599, JETZT), JETZT + 3599 * 1000);
});

test('Zoom schickt die Sekunden manchmal als Zeichenkette', () => {
  // Nicht erfunden: Bei Zoom sind Zahlen in JSON-Antworten schon als
  // Zeichenkette aufgetaucht. Number('3599') ist 3599, das traegt.
  assert.strictEqual(ablaufZeitpunkt('3599', JETZT), JETZT + 3599 * 1000);
});

test('DER EIGENTLICHE FALL: fehlt die Angabe, entsteht trotzdem eine Zahl', () => {
  // Das ist der Fehler, um den es geht. Vorher:
  //   Date.now() + undefined * 1000  ->  NaN
  const wert = ablaufZeitpunkt(undefined, JETZT);
  assert.ok(Number.isFinite(wert), 'Der Ablaufzeitpunkt muss eine endliche Zahl sein');
  assert.strictEqual(wert, JETZT + STANDARD_LEBENSDAUER_SEKUNDEN * 1000);
});

test('auch null, Unsinn und leere Zeichenkette ergeben eine Zahl', () => {
  for (const unbrauchbar of [null, '', 'bald', {}, [], NaN, Infinity]) {
    const wert = ablaufZeitpunkt(unbrauchbar, JETZT);
    assert.ok(
      Number.isFinite(wert),
      `ablaufZeitpunkt(${JSON.stringify(unbrauchbar)}) ergab ${wert}`
    );
  }
});

test('null und negative Werte ergeben kein Token, das sofort abgelaufen ist', () => {
  // Waere die Pruefung nur "Number.isFinite", ginge eine 0 durch - und das
  // Token waere in derselben Millisekunde abgelaufen, in der es entsteht.
  // Die Folge waere dieselbe wie beim NaN: Erneuerung bei jeder Anfrage.
  for (const wert of [0, -1, -3599]) {
    assert.strictEqual(
      ablaufZeitpunkt(wert, JETZT),
      JETZT + STANDARD_LEBENSDAUER_SEKUNDEN * 1000,
      `${wert} haette zu einem sofort abgelaufenen Token gefuehrt`
    );
  }
});

test('WARUM DAS SCHLIMM WAR: NaN ueberlebt den Weg durch die Datei als null', () => {
  // Dieser Test beweist die Ursachenkette, die den Fehler so heimtueckisch
  // gemacht hat. Er prueft nicht die neue Funktion, sondern JavaScript
  // selbst - und steht hier, damit der Grund nicht verloren geht, wenn
  // irgendwann jemand die Rueckfallebene fuer ueberfluessig haelt.
  const alteRechnung = JETZT + undefined * 1000;
  assert.ok(Number.isNaN(alteRechnung), 'die alte Rechnung ergab NaN');

  const durchDieDatei = JSON.parse(JSON.stringify({ expires_at: alteRechnung }));
  assert.strictEqual(
    durchDieDatei.expires_at, null,
    'JSON kennt kein NaN - aus dem Ablaufzeitpunkt wird null'
  );

  // Und so las der Server es dann:
  const stillValid = durchDieDatei.expires_at && Date.now() < durchDieDatei.expires_at - 60_000;
  assert.ok(!stillValid, 'null ist falsy: das Token galt nie als gueltig');
});

test('mit der neuen Funktion ueberlebt der Wert den Weg durch die Datei', () => {
  const geschrieben = { expires_at: ablaufZeitpunkt(undefined, JETZT) };
  const gelesen = JSON.parse(JSON.stringify(geschrieben));

  assert.strictEqual(gelesen.expires_at, geschrieben.expires_at);

  const stillValid = gelesen.expires_at && JETZT < gelesen.expires_at - 60_000;
  assert.ok(stillValid, 'das Token muss jetzt als gueltig gelten');
});
