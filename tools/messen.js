// -------------------------------------------------------------------
// Nimmt die Oberflaeche in jedem Zustand und in jeder Fenstergroesse auf -
// und MISST sie dabei.
//
//   docker compose up -d            (oder: node server.js)
//   npx playwright install --with-deps chromium
//   node tools/messen.js
//
// Adresse in CUELIGHT_URL, Standard http://127.0.0.1:4000.
// .github/workflows/messen.yml richtet das alles selbst ein.
//
// WARUM ES DIESES SKRIPT GIBT: public/index.html sind knapp dreitausend
// Zeilen, davon rund tausend Stil - und keine einzige Zeile davon ist je
// vermessen worden. Alle Groessen entstehen aus clamp() mit vw/vh, der
// einzige strukturelle Umschalter ist hoch/quer. Ob damit auf einem
// 800px-Android-Tablet noch alles an der richtigen Stelle steht, laesst
// sich nicht lesen - das muss man ausmessen.
//
// UEBERNOMMEN AUS meldungen.app (werkzeuge/mache-bilder.js), wo dasselbe
// Werkzeug in zwei Tagen fuenf Fehler gefunden hat, die niemandem
// aufgefallen waren: abgeschnittene Namen, ein unerreichbarer Knopf auf
// dem Telefon im Querformat, zu kleine Tippziele, einen Platzhalter, der
// mitten im Wort endete, und eine Zeile, die aus dem Bildschirm ragte.
//
// Es aendert NICHTS. Es nimmt auf und rechnet nach.
// -------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const URL_BASIS = process.env.CUELIGHT_URL || 'http://127.0.0.1:4000';
const ZIEL = process.env.CUELIGHT_MESSUNG || path.join(__dirname, '..', 'darstellung');

// --- Die Fenstergroessen -------------------------------------------------
//
// Ausgewaehlt nach den Geraeten, die tatsaechlich vorkommen: ein iPad am
// Pult, moeglicherweise Android-Tablets, moeglicherweise irgendwann ein
// Telefon. Dazu ein Pult-Monitor.
//
// 844x390 ist die Groesse, auf die es besonders ankommt: ein Telefon im
// Querformat. Dort greifen fast alle clamp()-Untergrenzen gleichzeitig,
// und die Hoehe ist am knappsten.
const GROESSEN = [
  { name: 'ipad-hoch', width: 810, height: 1080 },
  { name: 'ipad-quer', width: 1080, height: 810 },
  { name: 'ipadpro-quer', width: 1194, height: 834 },
  { name: 'android-tablet-quer', width: 1280, height: 800 },
  { name: 'android-tablet-hoch', width: 800, height: 1280 },
  { name: 'telefon-hoch', width: 390, height: 844 },
  { name: 'telefon-quer', width: 844, height: 390 },
  { name: 'pult-monitor', width: 1920, height: 1080 },
];

/** Eine Meldung, wie die Oberflaeche sie intern fuehrt. */
function meldung(id, name, sekunden, offen = false) {
  return [id, { name, muted: !offen, since: Date.now() - sekunden * 1000, userId: id }];
}

// Namen bewusst erfunden: Die Bilder landen als Artefakt im Lauf, echte
// Namen haben darin nichts verloren.
const NAMEN = [
  'Anna Weber', 'Thomas Krüger', 'Miriam Lang', 'Jonas Behrend',
  'Peter Adam', 'Sabine Reuter', 'Klaus Berger', 'Ute Hoffmann',
  'Martin Vogel', 'Elke Neumann', 'Rita Sommer', 'Bernd Kaiser',
  'Lena Fuchs', 'Otto Braun',
];

// --- Die Zustaende -------------------------------------------------------
const ZUSTAENDE = [
  { name: 'einwahl', ziel: '#setup', tun: 'einwahl' },
  { name: 'einwahl-gefuellt', ziel: '#setup', tun: 'einwahlGefuellt' },
  { name: 'freigabe-noetig', ziel: '#setup', tun: 'freigabe' },
  { name: 'board-ruhe', ziel: '#board', tun: 'board', kacheln: 0 },
  { name: 'board-redezeit', ziel: '#board', tun: 'board', kacheln: 0, zeit: 5 },
  { name: 'board-namen', ziel: '#board', tun: 'board', kacheln: 0, namen: true },
  { name: 'board-1-kachel', ziel: '#board', tun: 'board', kacheln: 1 },
  { name: 'board-3-kacheln', ziel: '#board', tun: 'board', kacheln: 3 },
  { name: 'board-7-kacheln', ziel: '#board', tun: 'board', kacheln: 7 },
  { name: 'board-kacheln-zeit', ziel: '#board', tun: 'board', kacheln: 3, zeit: 5 },
  { name: 'board-langer-name', ziel: '#board', tun: 'board', kacheln: 2, langerName: true },
];

/**
 * Wird in der Seite ausgefuehrt. Setzt den gewuenschten Zustand direkt,
 * ohne echtes Meeting - genauso wie tools/screenshots.js es schon tut.
 */
function stelleEin({ art, kacheln, zeit, namen, langerName, liste }) {
  // Aufklapper aufklappen. Was zugeklappt ist, sieht niemand - und was
  // niemand sieht, kann auch nicht falsch stehen. Gemessen wird deshalb
  // der unguenstigere Fall: alles offen.
  //
  // WARUM DAS HIER STEHT: Ohne diese Zeile meldete der erste Lauf 20
  // unerreichbare Elemente - #resetAuthBtn und cl-hint, in sechs
  // Groessen. Die liegen im zugeklappten <details> "Lesezeichen-Link und
  // Zoom-Freigabe". Chromium gibt solchen Knoten weiterhin ein Rechteck,
  // also ragten sie rechnerisch aus dem Fenster, waehrend die Aufnahme
  // eine vollstaendig passende Karte zeigte. Ein Fehlalarm des
  // Werkzeugs, kein Fehler der Anwendung.
  for (const aufklapper of document.querySelectorAll('details')) aufklapper.open = true;

  const setup = document.getElementById('setup');
  const board = document.getElementById('board');

  if (art !== 'board') {
    board.classList.remove('cl-active');
    setup.style.display = '';
    const auth = document.getElementById('authNeeded');
    if (auth) auth.style.display = art === 'freigabe' ? '' : 'none';

    if (art === 'einwahlGefuellt') {
      document.getElementById('meetingNumber').value = '812 3456 7890';
      document.getElementById('password').value = 'saal2026';
      document.getElementById('displayName').value = 'Anzeige Saal';
    }
    return;
  }

  setup.style.display = 'none';
  board.classList.add('cl-active');

  // Die Namen dieser Variablen stammen aus public/index.html - sie liegen
  // dort im globalen Geltungsbereich, genau wie tools/screenshots.js es
  // schon ausnutzt.
  isHostOrCoHost = true;
  hasEverConnected = true;
  imMeeting = true;
  totalAttendees = 14;
  currentMeetingNumber = '12345678901';
  meetingTopic = 'Beispiel-Versammlung';

  teilnehmer = namen
    ? liste.map((name) => ({ name, muted: true }))
    : [];

  raisedHands.clear();
  listEl.innerHTML = '';
  rowElements.clear();
  for (const [id, info] of liste.meldungen || []) raisedHands.set(id, info);

  if (zeit) {
    // Die Redezeit laeuft ueber dieselben Knoepfe wie im Betrieb - so
    // wird gemessen, was auch zu sehen waere.
    const knopf = document.querySelector(`.cl-min[data-min="${zeit}"]`);
    if (knopf) knopf.click();
  }

  render();
}

/** Wird in der Seite ausgefuehrt und liefert die Messwerte. */
function messe(wahl) {
  const ziel = document.querySelector(wahl);
  const rund = (n) => Math.round(n * 10) / 10;
  const vpB = window.innerWidth;
  const vpH = window.innerHeight;
  if (!ziel) return { fehler: `${wahl} nicht gefunden` };

  const nameVon = (el) => (el.id ? `#${el.id}` : (el.className || el.tagName.toLowerCase()));

  // Wird dieses Element ueberhaupt dargestellt? Der Gegencheck zum
  // Aufklappen oben: Bleibt irgendwo etwas uebrig, das nicht gerendert
  // wird, soll es nicht als Befund erscheinen.
  const sichtbar = (el) => (typeof el.checkVisibility === 'function'
    ? el.checkVisibility({ visibilityProperty: true })
    : true);

  /** Der naechste Vorfahr, in dem man scrollen kann. */
  function scrollbarerVorfahr(el) {
    let p = el.parentElement;
    while (p) {
      const s = getComputedStyle(p);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
      p = p.parentElement;
    }
    return null;
  }

  // 1. Ragt etwas aus dem Fenster - und kommt man hin?
  const ueberlauf = [];
  for (const el of ziel.querySelectorAll('*')) {
    if (!sichtbar(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const raus = {
      oben: r.top < -0.5 ? rund(-r.top) : null,
      unten: r.bottom > vpH + 0.5 ? rund(r.bottom - vpH) : null,
      links: r.left < -0.5 ? rund(-r.left) : null,
      rechts: r.right > vpB + 0.5 ? rund(r.right - vpB) : null,
    };
    if (raus.oben || raus.unten || raus.links || raus.rechts) {
      const traeger = scrollbarerVorfahr(el);
      ueberlauf.push({ was: nameVon(el), ...raus, erreichbar: Boolean(traeger), traeger: traeger ? nameVon(traeger) : null });
    }
  }

  // 2. Antippbare Flaechen. Fliesstext-Verweise zaehlen nicht mit -
  //    WCAG 2.5.8 nimmt Ziele "in a sentence or block of text" aus.
  const tippziele = [];
  for (const el of ziel.querySelectorAll('button, a, input, select, .cl-row')) {
    if (!sichtbar(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (getComputedStyle(el).display === 'inline') continue;
    tippziele.push({
      was: nameVon(el),
      text: (el.textContent || '').trim().slice(0, 30),
      breite: rund(r.width),
      hoehe: rund(r.height),
      zuKlein: r.height < 43.5 || r.width < 43.5,
    });
  }

  // 3. Abgeschnittener Text - nur dort, wo ueberhaupt gekuerzt wird.
  const gekuerzt = [];
  for (const el of ziel.querySelectorAll('*')) {
    if (!sichtbar(el)) continue;
    if (!el.getClientRects().length) continue;
    if (getComputedStyle(el).textOverflow !== 'ellipsis') continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      gekuerzt.push({
        was: nameVon(el),
        text: (el.textContent || '').trim().slice(0, 40),
        platz: rund(el.clientWidth),
        gebraucht: rund(el.scrollWidth),
      });
    }
  }

  // 4. Platzhalter in Eingabefeldern. Sie werden HART abgeschnitten,
  //    ohne Puenktchen - scrollWidth waechst dabei nicht, der Test oben
  //    sieht sie also nicht. Gemessen wird mit einem Canvas.
  const platzhalter = [];
  const stift = document.createElement('canvas').getContext('2d');
  for (const el of ziel.querySelectorAll('input[placeholder]')) {
    if (!sichtbar(el)) continue;
    if (!el.getClientRects().length || el.value) continue;
    const text = el.placeholder;
    if (!text) continue;
    const s = getComputedStyle(el);
    stift.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const sperrung = parseFloat(s.letterSpacing) || 0;
    const gebraucht = stift.measureText(text).width + sperrung * text.length;
    const platz = el.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0);
    if (gebraucht > platz + 1) {
      platzhalter.push({ was: nameVon(el), text, platz: rund(platz), gebraucht: rund(gebraucht) });
    }
  }

  // 5. Ein paar Schriftgroessen, damit sich die clamp()-Formeln
  //    nachrechnen lassen, ohne sie zu rechnen.
  const schriften = {};
  for (const [bez, w] of Object.entries({
    uhr: '#clock',
    kachelName: '.cl-row .cl-name',
    hinweis: '#setupHead',
    feld: '#meetingNumber',
    namensliste: '#attendeeNames div',
  })) {
    const el = document.querySelector(w);
    if (el && el.getClientRects().length) {
      schriften[bez] = rund(parseFloat(getComputedStyle(el).fontSize));
    }
  }

  return {
    fenster: `${vpB}x${vpH}`,
    seitwaerts: rund(document.documentElement.scrollWidth - vpB),
    ueberlauf,
    tippziele,
    gekuerzt,
    platzhalter,
    schriften,
  };
}

// -------------------------------------------------------------------

(async () => {
  fs.mkdirSync(ZIEL, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const messwerte = [];
  let fehlgeschlagen = 0;

  for (const groesse of GROESSEN) {
    for (const zustand of ZUSTAENDE) {
      const datei = `${zustand.name}--${groesse.name}.png`;
      const ctx = await browser.newContext({
        viewport: { width: groesse.width, height: groesse.height },
        deviceScaleFactor: 2,
        reducedMotion: 'no-preference',
      });
      const p = await ctx.newPage();

      // Ohne Netz nach draussen wuerde der SDK-Aufruf haengen.
      await p.route('**source.zoom.us/**', (r) => r.abort());

      const klagen = [];
      p.on('pageerror', (e) => klagen.push(String(e.message).slice(0, 200)));

      try {
        await p.goto(`${URL_BASIS}/`, { waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(900);

        const anzahl = zustand.kacheln || 0;
        const meldungen = [];
        for (let i = 0; i < anzahl; i++) {
          const name = zustand.langerName && i === 0
            ? 'Maximiliane Schwarzenbach-Hohenlohe'
            : NAMEN[i % NAMEN.length];
          meldungen.push([i + 1, {
            name,
            muted: i !== 0,
            since: Date.now() - (anzahl - i) * 7000,
            userId: i + 1,
          }]);
        }

        await p.evaluate(stelleEin, {
          art: zustand.tun,
          kacheln: anzahl,
          zeit: zustand.zeit || 0,
          namen: Boolean(zustand.namen),
          langerName: Boolean(zustand.langerName),
          liste: Object.assign(NAMEN.slice(), { meldungen }),
        });

        // Lange genug, dass jeder Uebergang durch ist - sonst nimmt das
        // Bild einen Zwischenstand auf und die Messung misst ihn mit.
        await p.waitForTimeout(900);

        await p.locator(zustand.ziel).screenshot({ path: path.join(ZIEL, datei) });
        const werte = await p.evaluate(messe, zustand.ziel);
        messwerte.push({ zustand: zustand.name, groesse: groesse.name, datei, klagen, ...werte });
        process.stdout.write('.');
      } catch (err) {
        fehlgeschlagen += 1;
        messwerte.push({
          zustand: zustand.name, groesse: groesse.name, datei,
          fehler: String(err.message).slice(0, 300), klagen,
        });
        process.stdout.write('x');
      } finally {
        await ctx.close();
      }
    }
  }

  await browser.close();
  console.log('');

  fs.writeFileSync(path.join(ZIEL, 'messwerte.json'), JSON.stringify(messwerte, null, 2));
  fs.writeFileSync(path.join(ZIEL, 'messwerte.md'), bericht(messwerte));

  console.log(`${messwerte.length} Aufnahmen, ${fehlgeschlagen} fehlgeschlagen.`);
  console.log(`Ergebnis in ${ZIEL}`);
})();

// --- Der Bericht ---------------------------------------------------------
//
// Bewusst als Text und nicht nur als JSON: Er soll sich lesen lassen, ohne
// ihn erst zu verarbeiten. Was NICHT auffaellt, steht auch nicht drin -
// eine Tabelle mit hundert Zeilen "alles in Ordnung" liest niemand.
function bericht(werte) {
  const z = [];
  z.push('# Messwerte der CueLight-Oberflaeche', '');
  z.push(`${werte.length} Aufnahmen. Nur Auffaelligkeiten stehen hier;`);
  z.push('alle Zahlen liegen daneben in messwerte.json.', '');

  const fehler = werte.filter((w) => w.fehler);
  if (fehler.length) {
    z.push('## Fehlgeschlagene Aufnahmen', '');
    for (const w of fehler) z.push(`- **${w.zustand} / ${w.groesse}**: ${w.fehler}`);
    z.push('');
  }

  const mitKlagen = werte.filter((w) => w.klagen && w.klagen.length);
  if (mitKlagen.length) {
    z.push('## JavaScript-Fehler in der Seite', '');
    for (const w of mitKlagen) z.push(`- **${w.zustand} / ${w.groesse}**: ${w.klagen.join(' | ')}`);
    z.push('');
  }

  const verloren = [];
  const erreichbar = [];
  for (const w of werte) {
    for (const u of (w.ueberlauf || [])) (u.erreichbar ? erreichbar : verloren).push({ w, u });
  }

  z.push('## Unerreichbarer Inhalt', '');
  if (!verloren.length) {
    z.push('Nichts. Bei keiner Groesse und in keinem Zustand ragt etwas aus dem', '');
    z.push('Fenster, ohne dass man hinscrollen koennte.', '');
  } else {
    z.push('Ragt aus dem Fenster UND liegt in keinem Scrollbereich - das ist die', '');
    z.push('Sorte, bei der ein Knopf schlicht nicht zu druecken ist.', '');
    z.push('| Zustand | Groesse | Element | oben | unten | links | rechts |');
    z.push('|---|---|---|---|---|---|---|');
    for (const { w, u } of verloren) {
      z.push(`| ${w.zustand} | ${w.groesse} | \`${u.was}\` | ${u.oben || '-'} | ${u.unten || '-'} | ${u.links || '-'} | ${u.rechts || '-'} |`);
    }
    z.push('');
  }

  z.push('## Waagerechter Ueberlauf', '');
  const quer = werte.filter((w) => w.seitwaerts && w.seitwaerts > 1);
  if (!quer.length) {
    z.push('Nichts. Keine Groesse rollt seitwaerts.', '');
  } else {
    z.push('| Zustand | Groesse | ragt hinaus um |');
    z.push('|---|---|---|');
    for (const w of quer) z.push(`| ${w.zustand} | ${w.groesse} | ${w.seitwaerts} px |`);
    z.push('');
  }

  z.push('## Abgeschnittener Text', '');
  const kurz = werte.filter((w) => w.gekuerzt && w.gekuerzt.length);
  if (!kurz.length) {
    z.push('Nichts.', '');
  } else {
    z.push('| Zustand | Groesse | Element | Platz | gebraucht | Text |');
    z.push('|---|---|---|---|---|---|');
    for (const w of kurz) {
      for (const g of w.gekuerzt) {
        z.push(`| ${w.zustand} | ${w.groesse} | \`${g.was}\` | ${g.platz} | ${g.gebraucht} | ${g.text} |`);
      }
    }
    z.push('');
  }

  z.push('## Abgeschnittener Platzhaltertext', '');
  const ph = werte.filter((w) => w.platzhalter && w.platzhalter.length);
  if (!ph.length) {
    z.push('Nichts.', '');
  } else {
    z.push('Ein Eingabefeld schneidet seinen Platzhalter hart ab, ohne', '');
    z.push('Puenktchen - man sieht dem Wort nicht an, dass es weitergeht.', '');
    z.push('| Zustand | Groesse | Feld | Platz | gebraucht | Text |');
    z.push('|---|---|---|---|---|---|');
    for (const w of ph) {
      for (const p of w.platzhalter) {
        z.push(`| ${w.zustand} | ${w.groesse} | \`${p.was}\` | ${p.platz} | ${p.gebraucht} | ${p.text} |`);
      }
    }
    z.push('');
  }

  z.push('## Antippbare Flaechen unter 44 Pixel', '');
  const klein = new Map();
  for (const w of werte) {
    for (const t of (w.tippziele || [])) {
      if (!t.zuKlein) continue;
      const s = `${t.was} — "${t.text}"`;
      if (!klein.has(s)) klein.set(s, []);
      klein.get(s).push(`${w.groesse}: ${t.breite}x${t.hoehe}`);
    }
  }
  if (!klein.size) {
    z.push('Keine.', '');
  } else {
    for (const [was, wo] of klein) {
      z.push(`- **${was}**`);
      z.push(`  ${[...new Set(wo)].join(' · ')}`);
    }
    z.push('');
  }

  return z.join('\n');
}
