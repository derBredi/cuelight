// Erzeugt die Bilder für die README aus der echten Anwendung.
//
//   node tools/screenshots.js
//
// Voraussetzung: CueLight läuft lokal (Standard: http://127.0.0.1:4000)
// und Playwright ist installiert. Der Zustand des Boards wird dabei direkt
// gesetzt, es wird also kein echtes Zoom-Meeting benötigt.

const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = process.env.CUELIGHT_URL || 'http://127.0.0.1:4000';
const OUT = path.join(__dirname, '..', 'assets');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const BREITE_GIF = 480;   // Breite des GIF in Pixeln
const START = 2.2;        // Sekunden am Anfang wegschneiden (Seitenaufbau)
const DAUER = 18.5;        // Laenge des fertigen GIF

// iPad im Hochformat: So wird CueLight in der Praxis benutzt - ein Gerät,
// das hochkant am Pult steht. Das zweispaltige Querformat ist ein
// Sonderfall und muss im Bild nicht vorkommen.
const PAD = { width: 820, height: 1180 };

function meldung(id, name, sekunden, offen = false) {
  return [id, { name, muted: !offen, since: Date.now() - sekunden * 1000, userId: id }];
}

async function boardVorbereiten(page, meldungen) {
  await page.evaluate((liste) => {
    setupEl.style.display = 'none';
    boardEl.classList.add('cl-active');
    isHostOrCoHost = true;
    hasEverConnected = true;
    totalAttendees = 14;
    // Bewusst erfunden: Das Bild landet oeffentlich im Repo, echte
    // Meeting-Nummern haben darin nichts verloren.
    currentMeetingNumber = '12345678901';
    meetingTopic = 'Beispiel-Versammlung';
    // Fuer den Ruhezustand am Ende des Films: Uhr und Teilnehmerliste.
    teilnehmer = [
      'Anna Weber', 'Thomas Krüger', 'Miriam Lang', 'Jonas Behrend',
      'Peter Adam', 'Sabine Reuter', 'Klaus Berger', 'Ute Hoffmann',
      'Martin Vogel', 'Elke Neumann', 'Rita Sommer', 'Bernd Kaiser',
      'Lena Fuchs', 'Otto Braun',
    ].map((name) => ({ name, muted: true }));
    raisedHands.clear();
    listEl.innerHTML = '';
    rowElements.clear();
    for (const [id, info] of liste) raisedHands.set(id, info);
    render();
  }, meldungen);
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ---------------------------------------------------------------
  // Standbild: Board im Querformat
  // ---------------------------------------------------------------
  const ctx = await browser.newContext({ viewport: PAD, deviceScaleFactor: 2 });
  const board = await ctx.newPage();
  await board.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await board.waitForTimeout(1200);
  await boardVorbereiten(board, [
    meldung(1, 'Anna Weber', 41, true),
    meldung(2, 'Thomas Krüger', 24),
    meldung(3, 'Miriam Lang', 11),
    meldung(4, 'Jonas Behrend', 4),
  ]);
  await board.waitForTimeout(400);
  await board.screenshot({ path: path.join(OUT, 'screenshot-board.png'), animations: 'disabled' });
  console.log('assets/screenshot-board.png');
  await ctx.close();

  // ---------------------------------------------------------------
  // Bewegtbild: Meldungen kommen herein, eine wird freigeschaltet
  // ---------------------------------------------------------------
  const videoDir = fs.mkdtempSync('/tmp/cuelight-video-');
  const vctx = await browser.newContext({
    viewport: PAD,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: PAD },
  });
  const film = await vctx.newPage();
  await film.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await film.waitForTimeout(1000);
  await boardVorbereiten(film, []);
  await film.waitForTimeout(1200);

  // Der Ablauf zeigt bewusst die Sortierung: Es wird NICHT die vorderste
  // Kachel freigeschaltet, sondern die zuletzt hinzugekommene - sie springt
  // dadurch nach vorn. Wird sie danach wieder stummgeschaltet, wandert sie
  // als "war schon dran" ans Ende. Genau das sieht man auf einem Standbild
  // nicht. Die Fingertipps werden mitgezeigt, damit erkennbar ist, dass die
  // Wechsel von einer Bedienung ausgeloest werden und nicht von selbst
  // passieren.
  const schritte = [
    { warten: 2200, tun: () => {
        const n = Date.now();
        raisedHands.set(1, { name: 'Anna Weber', muted: true, since: n - 34000, userId: 1 });
        raisedHands.set(2, { name: 'Thomas Krüger', muted: true, since: n - 12000, userId: 2 });
      } },
    { warten: 2600, tun: () => { raisedHands.set(3, { name: 'Miriam Lang', muted: true, since: Date.now(), userId: 3 }); } },
    // Freischalten: Tipp auf Miriam. Der Bedienhinweis verschwindet dabei,
    // weil er seinen Zweck erfuellt hat.
    { druecken: () => rowElements.get(3), warten: 3800, tun: () => {
        hideHint();
        const i = raisedHands.get(3);
        i.muted = false;
        i.hasSpoken = true;
        lastMuteCallAt = Date.now();
      } },
    // Wieder stumm: wandert als "war schon dran" ans Ende.
    { druecken: () => rowElements.get(3), warten: 3600, tun: () => {
        raisedHands.get(3).muted = true;
        lastMuteCallAt = Date.now();
      } },
    // Zum Schluss alle Haende herunternehmen.
    { druecken: () => lowerAllBtn, warten: 1800, tun: () => {
        for (const id of raisedHands.keys()) scheduleLeave(id);
      } },
    { warten: 2800, tun: () => {} },
  ];

  for (const schritt of schritte) {
    if (schritt.druecken) {
      // Gedrueckt-Zustand kurz zeigen, wie ihn ein echter Fingertipp
      // ausloest - danach erst die Wirkung.
      await film.evaluate(`(function(){ var el = (${schritt.druecken.toString()})(); if (el) el.classList.add('cl-pressed'); })();`);
      await film.waitForTimeout(220);
      await film.evaluate(`(function(){ var el = (${schritt.druecken.toString()})(); if (el) el.classList.remove('cl-pressed'); })();`);
      await film.waitForTimeout(120);
    }
    await film.evaluate(`(${schritt.tun.toString()})(); render();`);
    await film.waitForTimeout(schritt.warten);
  }

  await vctx.close();

  const webm = fs.readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  const quelle = path.join(videoDir, webm);
  const palette = path.join(videoDir, 'palette.png');
  const ziel = path.join(OUT, 'demo.gif');

  // Zweistufig über eine eigene Farbtabelle - sonst werden Orange und
  // Grün im GIF fleckig.
  const filter = `fps=7,scale=${BREITE_GIF}:-2:flags=lanczos`;
  execFileSync(FFMPEG, ['-y', '-ss', String(START), '-t', String(DAUER), '-i', quelle,
    '-vf', filter + ',palettegen=max_colors=64', palette], { stdio: 'ignore' });
  execFileSync(FFMPEG, ['-y', '-ss', String(START), '-t', String(DAUER), '-i', quelle, '-i', palette,
    '-lavfi', filter + '[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5',
    '-loop', '0', ziel], { stdio: 'ignore' });
  console.log('assets/demo.gif  ', (fs.statSync(ziel).size / 1024 / 1024).toFixed(1), 'MB');

  await browser.close();
})();
