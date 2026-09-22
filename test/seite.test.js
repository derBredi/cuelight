'use strict';

// Ist das JavaScript in public/index.html ueberhaupt gueltig?
//
// WARUM ES DIESEN TEST GIBT: Der Schritt "Syntax" im Pruefungslauf geht
// ueber server.js, lib/*.js und tools/*.js. Das JavaScript, das die
// Anwendung am Pult tatsaechlich ausfuehrt, steht aber zu ueber neunzig
// Prozent in public/index.html - und eine HTML-Datei sieht "node --check"
// nicht an. Ein fehlendes Komma dort faellt bisher erst dem auf, der die
// Seite oeffnet; im schlimmsten Fall ist das jemand, der zwei Minuten vor
// der Zusammenkunft den Beamer anschliesst.
//
// Geprueft wird nur die Syntax, nicht das Verhalten: Der Text wird
// geparst, aber nicht ausgefuehrt. Das ist wenig - aber es ist genau der
// Fehler, der die ganze Seite auf einen Schlag stillegt, und er kostet
// eine Millisekunde.
//
// WAS ER NICHT KANN: Er sieht keine Tippfehler in Namen, keine falsche
// Reihenfolge, kein falsches Verhalten. Dafuer gibt es den Messlauf und
// das eigene Auge.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SEITE = path.join(__dirname, '..', 'public', 'index.html');

/**
 * Alle <script>-Bloecke ohne src, mit der Zeilennummer ihres Beginns -
 * ohne die ist eine Fehlermeldung wertlos, weil sie sich auf den
 * herausgeloesten Ausschnitt bezoege und nicht auf die Datei.
 */
function eigeneSkripte(html) {
  const bloecke = [];
  const muster = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const treffer of html.matchAll(muster)) {
    const davor = html.slice(0, treffer.index);
    bloecke.push({
      zeile: davor.split('\n').length,
      quelltext: treffer[1],
    });
  }
  return bloecke;
}

test('das JavaScript in der Seite laesst sich parsen', () => {
  const html = fs.readFileSync(SEITE, 'utf8');
  const bloecke = eigeneSkripte(html);

  // Zwei sind es heute: die Stilhilfen ganz oben und die Anwendung
  // selbst. Waeren es null, haette die Suche sich vertan und der Test
  // wuerde gruen leuchten, ohne etwas geprueft zu haben.
  assert.ok(bloecke.length >= 2, `nur ${bloecke.length} eigene Skriptbloecke gefunden`);

  for (const block of bloecke) {
    try {
      // new vm.Script parst, fuehrt aber nichts aus. Genau das ist hier
      // gewollt: Die Seite spricht mit dem Zoom-SDK und dem DOM, beides
      // gibt es hier nicht.
      new vm.Script(block.quelltext, { filename: `public/index.html (ab Zeile ${block.zeile})` });
    } catch (fehler) {
      assert.fail(
        `Der Skriptblock ab Zeile ${block.zeile} von public/index.html ist ` +
        `kein gueltiges JavaScript:\n  ${fehler.message}`
      );
    }
  }
});

test('die Seite laedt das Zoom-SDK in einer festen Fassung', () => {
  // Ohne Fassungsnummer holt die Seite, was Zoom gerade ausliefert. Genau
  // daran ist in meldungen.app schon einmal die Anzeige im Warteraum
  // gescheitert - eine SDK-Aenderung, die niemand hier ausgeloest hat.
  const html = fs.readFileSync(SEITE, 'utf8');
  const quellen = [...html.matchAll(/<script[^>]*\ssrc="(https:\/\/source\.zoom\.us\/[^"]+)"/g)]
    .map((t) => t[1]);

  assert.ok(quellen.length > 0, 'die Seite laedt das Zoom-SDK gar nicht mehr');

  const ohneFassung = quellen.filter((u) => !/\/\d+\.\d+\.\d+\//.test(u));
  assert.deepStrictEqual(
    ohneFassung, [],
    'ohne feste Fassungsnummer geladen:\n  ' + ohneFassung.join('\n  ')
  );

  // Und alle aus derselben. Gemischte Fassungen von React und SDK sind
  // der Fehler, den man erst im Meeting sieht.
  const fassungen = new Set(quellen.map((u) => u.match(/\/(\d+\.\d+\.\d+)\//)[1]));
  assert.strictEqual(
    fassungen.size, 1,
    `die Seite mischt SDK-Fassungen: ${[...fassungen].join(', ')}`
  );
});
