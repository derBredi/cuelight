'use strict';

// Was die Oberflaeche TUT - nicht, wie sie aussieht oder ob sie sich
// parsen laesst.
//
// WARUM ES DIESEN TEST GIBT: CueLight hatte fuer public/index.html genau
// zwei Tests - ob das Skript parst und ob das Zoom-SDK auf einer festen
// Fassung steht (test/seite.test.js). Dabei stehen ueber neunzig Prozent
// der Anwendung in dieser einen Datei. Der gesamte Verlauf einer
// Sitzung - beitreten, verbinden, Verbindung verlieren, verlassen - war
// ungeprueft.
//
// Uebernommen aus meldungen.app (app/test/anzeige-verhalten.test.js).
// Das ist kein Zufall: Einundsiebzig Prozent des Skripts hier stehen
// woertlich auch dort. Die beiden Fehler, die diese Tests nachstellen,
// sind in beiden Anwendungen aufgetreten - erst hier, dann dort.
//
// WIE DAS HIER GEHT: jsdom laedt public/index.html wirklich, mit einer
// Attrappe an der Stelle des Zoom-SDK. Weil die Funktionen der Seite in
// einem klassischen <script> auf oberster Ebene stehen, liegen sie
// danach auf window; die Zustandsvariablen sind "let" und damit ueber
// window.eval lesbar UND setzbar.
//
//     npm install --no-save jsdom
//
// WAS DIESER TEST NICHT KANN: Er sieht kein Layout und keine
// Trefferflaeche - jsdom rechnet kein CSS aus. Dafuer gibt es den
// Messlauf mit Playwright (tools/messen.js).
//
// WAS HIER ANDERS IST ALS IN meldungen.app, und zwar mit Absicht:
// CueLight kennt keinen Bildschirm-Automaten (zeigeBildschirm, sechs
// Bildschirme) - es schaltet zwischen Einrichtung und Pult direkt um. Und
// seine Stale-Wache meldet nur, waehrend die dortige nach 25 Sekunden neu
// laedt: Vor CueLight sitzt jemand, vor der Anzeige auf der Buehne nicht.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SEITE = path.join(__dirname, '..', 'public', 'index.html');

let JSDOM = null;
let ladefehler = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch (fehler) {
  ladefehler = fehler.message;
}

// Fehlt jsdom, darf dieser Test NICHT still gruen sein. Eine
// uebersprungene Pruefung sieht im Bericht aus wie eine bestandene.
if (!JSDOM) {
  if (process.env.GITHUB_ACTIONS) {
    test('jsdom muss im Lauf vorhanden sein', () => {
      assert.fail(
        'jsdom fehlt: ' + ladefehler +
        '\nDer Lauf muss "npm install --no-save jsdom" ausfuehren, bevor er testet.'
      );
    });
  } else {
    test('Verhalten der Oberflaeche', { skip: 'jsdom fehlt - "npm install --no-save jsdom"' }, () => {});
  }
  return;
}

async function lade({ verbiege = null, suche = '' } = {}) {
  let html = fs.readFileSync(SEITE, 'utf8')
    .replace(/<script[^>]*src="https:\/\/source\.zoom\.us\/[^"]*"[^>]*><\/script>\s*/g, '');
  if (verbiege) html = verbiege(html);

  const sdkRufe = [];
  const holen = [];
  const intervalle = [];
  const neuladungen = [];

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost:4000/' + suche,
    // location.reload() ist in jsdom nicht vorgesehen und laesst sich auch
    // nicht ersetzen ("Cannot redefine property"). jsdom meldet den Versuch
    // aber selbst - das ist hier die Handhabe, um ein Neuladen zu zaehlen.
    virtualConsole: new (require('jsdom').VirtualConsole)()
      .on('jsdomError', (fehler) => {
        if (/Not implemented: navigation/.test(String(fehler.message))) {
          neuladungen.push(String(fehler.message));
        }
      }),
    beforeParse(w) {
      w.ZoomMtg = new Proxy({}, {
        get: (_z, name) => (typeof name === 'string'
          ? (...args) => { sdkRufe.push({ name, args }); }
          : undefined),
      });

      w.matchMedia = () => ({
        matches: false,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
      });

      // Ohne Attrappe reisst der fetch('/api/version') auf oberster Ebene
      // das restliche Skript mit.
      w.fetch = (adresse, optionen) => {
        holen.push({ adresse: String(adresse), optionen });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      };

      Object.defineProperty(w.navigator, 'wakeLock', {
        configurable: true,
        value: { request: () => Promise.resolve({ release: () => Promise.resolve(), addEventListener() {} }) },
      });

      // Intervalle einsammeln statt laufen lassen: bestimmt, und die
      // Stale-Wache laesst sich so genau einmal ausloesen statt fuenf
      // Sekunden auf sie zu warten.
      w.setInterval = (fn, ms) => { intervalle.push({ fn, ms }); return intervalle.length; };
      w.clearInterval = (id) => { if (intervalle[id - 1]) intervalle[id - 1].geloescht = true; };
    },
  });

  const w = dom.window;
  await new Promise((fertig) => setTimeout(fertig, 0));

  return {
    dom, w, sdkRufe, holen, intervalle, neuladungen,

    lies: (name) => w.eval(`typeof ${name} === 'undefined' ? undefined : ${name}`),
    setze: (name, wert) => w.eval(`${name} = ${JSON.stringify(wert)}`),

    /** Steht die Einrichtung oder das Pult im Bild? */
    amPult: () => w.document.getElementById('board').classList.contains('cl-active'),

    balken() {
      const el = w.document.getElementById('connectionBanner');
      if (!el || el.style.display === 'none' || el.style.display === '') return null;
      return el.querySelector('span').textContent;
    },

    wacheEinmal() {
      const wache = intervalle.find((i) => i.ms === 5000 && !i.geloescht);
      assert.ok(wache, 'kein 5000er-Intervall gefunden - haengt die Stale-Wache noch dort?');
      wache.fn();
    },

    schliesse: () => dom.window.close(),
  };
}

// --- Der Ruhezustand -----------------------------------------------------

test('ohne gemerkte Einwahl bleibt CueLight bei der Einrichtung', async () => {
  const a = await lade();
  try {
    assert.strictEqual(a.amPult(), false, 'ohne Einwahldaten gehoert das Pult nicht ins Bild');
    assert.strictEqual(a.balken(), null, 'und ein Hinweisbalken erst recht nicht');
    assert.deepStrictEqual(a.sdkRufe, [], 'es darf nichts mit Zoom gesprochen werden');
  } finally { a.schliesse(); }
});

// --- Die Statusereignisse des SDK ---------------------------------------

test('Status 2 heisst verbunden: der Balken geht weg', async () => {
  const a = await lade();
  try {
    a.w.showConnectionWarning('irgendwas');
    assert.strictEqual(a.balken(), 'irgendwas');

    a.w.handleMeetingStatus({ meetingStatus: 2 });
    assert.strictEqual(a.balken(), null);
    assert.strictEqual(a.lies('hasEverConnected'), true);
  } finally { a.schliesse(); }
});

test('Ereignisse ohne Statuszahl gehen die Oberflaeche nichts an', async () => {
  const a = await lade();
  try {
    for (const daten of [undefined, null, {}, { detail: 'irgendwas' }, { meetingStatus: 'zwei' }]) {
      a.w.handleMeetingStatus(daten);
      assert.strictEqual(a.balken(), null, `bei ${JSON.stringify(daten)}`);
    }
    assert.strictEqual(a.lies('hasEverConnected'), false);
  } finally { a.schliesse(); }
});

// --- Die Wache, an der es zuletzt gefehlt hat ---------------------------

test('nach dem gewollten Verlassen schweigt jedes Statusereignis', async () => {
  const a = await lade();
  try {
    a.setze('verlassenGewollt', true);

    // Status 4 ZUERST: Genau daran ist es zerbrochen. Das SDK meldet auf dem
    // Weg hinaus gern erst "verbindet neu" und dann "getrennt". Stand die
    // Wache nur im 1/3-Zweig, setzte Status 4 den Balken "Verbindung wird
    // wiederhergestellt ..." - und hier blitzte er sichtbar auf, weil vor
    // CueLight kein eigener Bildschirm liegt, der ihn zudeckt.
    a.w.handleMeetingStatus({ meetingStatus: 4 });
    assert.strictEqual(a.balken(), null, 'Status 4 nach dem Verlassen darf nichts mehr setzen');

    for (const status of [1, 3]) {
      a.w.handleMeetingStatus({ meetingStatus: status });
      assert.strictEqual(a.balken(), null, `Status ${status} nach dem Verlassen`);
    }
  } finally { a.schliesse(); }
});

test('der zweite Tipp auf Verlassen setzt die Wache', async () => {
  const a = await lade();
  try {
    const knopf = a.w.document.getElementById('leaveBtn');
    assert.ok(knopf, 'den Verlassen-Knopf muss es geben');

    knopf.dispatchEvent(new a.w.Event('click', { bubbles: true }));
    assert.strictEqual(a.lies('verlassenGewollt'), false, 'die Nachfrage ist noch kein Verlassen');

    knopf.dispatchEvent(new a.w.Event('click', { bubbles: true }));
    assert.strictEqual(a.lies('verlassenGewollt'), true);
  } finally { a.schliesse(); }
});

// --- Die Stale-Wache ----------------------------------------------------

test('die Stale-Wache schweigt, solange CueLight nie im Meeting war', async () => {
  const a = await lade();
  try {
    // Rueckmeldung aus dem Betrieb: "Keine Aktualisierung seit 25s" blitzte
    // auf, waehrend "Verbinde ..." noch dastand. hasEverConnected kippt mit
    // dem Statusereignis und damit VOR der gefuellten Teilnehmerliste.
    a.setze('hasEverConnected', true);
    a.setze('lastSuccessfulPollAt', Date.now() - 300000);

    a.wacheEinmal();

    assert.strictEqual(a.balken(), null, 'vor dem ersten Drinsein darf die Wache nichts melden');
  } finally { a.schliesse(); }
});

test('die Stale-Wache schweigt auch nach dem gewollten Verlassen', async () => {
  const a = await lade();
  try {
    a.setze('imMeeting', true);
    a.setze('verlassenGewollt', true);
    a.setze('lastSuccessfulPollAt', Date.now() - 300000);

    a.wacheEinmal();

    assert.strictEqual(a.balken(), null);
  } finally { a.schliesse(); }
});

test('im Meeting meldet sich die Wache nach fuenfzehn Sekunden Stille', async () => {
  const a = await lade();
  try {
    // Die Gegenprobe zu den beiden oberen: Waere die Wache schlicht immer
    // still, bestuenden jene zwei Tests auch - und wuerden nichts bedeuten.
    a.setze('imMeeting', true);
    a.setze('lastSuccessfulPollAt', Date.now() - 18000);

    a.wacheEinmal();

    assert.ok(a.balken(), 'nach 18s Stille im Meeting gehoert ein Hinweis hin');
    // Und ANDERS als in meldungen.app bleibt es beim Hinweis. Dort laedt die
    // Anzeige nach 25s neu, weil auf der Buehne niemand eingreifen kann;
    // hier sitzt jemand davor.
    assert.strictEqual(a.neuladungen.length, 0, 'CueLight laedt dabei nicht neu');
  } finally { a.schliesse(); }
});

// --- Gegenproben ---------------------------------------------------------
//
// Ein Test, der nicht fehlschlagen KANN, ist kein Test. Die Wachen oben
// pruefen, dass nichts geschieht - und "nichts geschieht" stimmt auch dann,
// wenn der Test danebengreift. Also dieselben Faelle noch einmal mit einer
// absichtlich beschaedigten Seite: Dort MUSS die Oberflaeche anschlagen.

function ohneZeile(muster) {
  return (html) => {
    const treffer = html.match(muster);
    assert.ok(treffer, `Gegenprobe greift ins Leere: ${muster} steht nicht mehr in index.html`);
    return html.replace(muster, '');
  };
}

test('Gegenprobe: ohne die Wache vor den Zweigen setzt Status 4 den Balken doch', async () => {
  const a = await lade({
    verbiege: ohneZeile(/\n *if \(verlassenGewollt\) return;\n(?=\n *if \(status === 1 \|\| status === 3\))/),
  });
  try {
    a.setze('verlassenGewollt', true);
    a.w.handleMeetingStatus({ meetingStatus: 4 });

    assert.ok(
      a.balken(),
      'Ohne die Wache MUSS der Balken erscheinen. Tut er es nicht, prueft der Test darueber nichts.'
    );
  } finally { a.schliesse(); }
});

test('Gegenprobe: ohne "!imMeeting" meldet sich die Stale-Wache schon vor dem Beitritt', async () => {
  const a = await lade({
    verbiege: ohneZeile(/\n *if \(!imMeeting \|\| verlassenGewollt\) return;/),
  });
  try {
    a.setze('lastSuccessfulPollAt', Date.now() - 18000);
    a.wacheEinmal();

    assert.ok(
      a.balken(),
      'Ohne die Wache MUSS sich die Stale-Pruefung melden. Sonst prueft der Test darueber nichts.'
    );
  } finally { a.schliesse(); }
});
