'use strict';

// Enthaelt das Image alles, was der Server braucht?
//
// WARUM ES DIESEN TEST GIBT: Das Dockerfile kopiert bewusst nicht das
// ganze Verzeichnis, sondern einzelne Stuecke - so landen Tests, Werkzeuge
// und Entwuerfe nicht mit auf dem Geraet. Der Preis dafuer ist, dass jede
// neue Datei dort genannt werden muss.
//
// Beim ersten Anlauf zu v1.3.8 fehlte genau das: lib/ war neu, im
// Dockerfile stand es nicht, und der Container brach beim Start mit
// "Cannot find module './lib/ablauf'" ab.
//
// Aufgefallen ist es im Rauchtest - also erst, nachdem ein Tag gesetzt
// war, ein Image gebaut wurde und die halbe Veroeffentlichung gelaufen
// war. Das ist spaet. Dieser Test braucht keine Sekunde und laeuft bei
// jedem Push.
//
// WAS ER NICHT KANN: Er sieht nur, was server.js direkt verlangt. Eine
// Datei, die erst zur Laufzeit nachgeladen wird, findet er nicht - dafuer
// ist der Rauchtest weiterhin da. Er verschiebt die haeufigste Sorte
// Fehler nach vorn, er ersetzt nichts.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WURZEL = path.join(__dirname, '..');

function lies(name) {
  return fs.readFileSync(path.join(WURZEL, name), 'utf8');
}

test('jede eigene Datei, die server.js laedt, wird ins Image kopiert', () => {
  const server = lies('server.js');
  const dockerfile = lies('Dockerfile');

  // Nur die eigenen Module: require('./lib/ablauf'), nicht require('express').
  // package.json ist ausgenommen - die wird ohnehin zuerst kopiert.
  const eigene = [...server.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)]
    .map((t) => t[1])
    .filter((p) => p !== 'package.json');

  assert.ok(eigene.length > 0, 'In server.js wurde kein eigenes Modul gefunden.');

  // Was das Dockerfile mitnimmt - der erste Pfad je COPY-Zeile.
  const kopiert = [...dockerfile.matchAll(/^COPY\s+(?!--)(\S+)/gm)].map((t) => t[1]);

  const fehlend = [];
  for (const modul of eigene) {
    // "lib/ablauf" wird von "COPY lib ./lib" abgedeckt, "server.js" von
    // "COPY server.js ./". Verglichen wird deshalb das erste Stueck des
    // Pfades - genauer muss es nicht sein, und ungenauer darf es nicht.
    const oberste = modul.split('/')[0];
    const abgedeckt = kopiert.some(
      (k) => k === oberste || k === `${oberste}.js` || k.startsWith(`${oberste}/`)
    );
    if (!abgedeckt) fehlend.push(`  require('./${modul}') - im Dockerfile fehlt "COPY ${oberste}"`);
  }

  assert.deepStrictEqual(
    fehlend, [],
    'Das Image wuerde ohne diese Dateien gebaut und beim Start abbrechen:\n' +
    fehlend.join('\n')
  );
});

test('die Dateien, die das Dockerfile kopiert, gibt es auch', () => {
  // Die Gegenrichtung: Eine COPY-Zeile auf etwas Geloeschtes laesst den
  // BAU scheitern, nicht den Start - das faellt frueher auf, ist aber
  // hier fuer eine Sekunde mitgeprueft.
  const dockerfile = lies('Dockerfile');
  const kopiert = [...dockerfile.matchAll(/^COPY\s+(?!--)(\S+)/gm)]
    .map((t) => t[1])
    .filter((p) => !p.includes('*'));

  const fehlend = kopiert
    .filter((p) => !fs.existsSync(path.join(WURZEL, p)))
    .map((p) => `  ${p}`);

  assert.deepStrictEqual(
    fehlend, [],
    'Das Dockerfile kopiert Dateien, die es nicht gibt:\n' + fehlend.join('\n')
  );
});
