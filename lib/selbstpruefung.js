'use strict';

// Was fehlt noch, damit CueLight tut, wozu es da ist?
//
// WARUM DAS EINE EIGENE DATEI IST: Die Hinweise gab es schon - als drei
// console-Aufrufe, verstreut zwischen den Konstanten. Sie waren gut
// formuliert, aber sie liessen sich nicht pruefen, und niemand konnte
// sagen, ob sie vollstaendig sind. Als Funktion mit Rueckgabewert sind
// sie beides: pruefbar und an einer Stelle.
//
// WARUM SIE NICHTS SELBST NACHSIEHT: Die Funktion bekommt alles
// hineingereicht - die Umgebung und ein paar Tatsachen, die der Server
// vorher feststellt. So laesst sie sich mit erfundenen Lagen aufrufen,
// ohne dass irgendwo eine Datei angelegt oder ein Netz befragt wird.
//
// WARUM SIE DEN START NICHT ABBRICHT: CueLight steht in einem Saal und
// soll laufen. Ein Dienst, der wegen einer fehlenden Angabe gar nicht
// erst startet, hilft niemandem - dann sieht man auf dem Pult einen
// Fehler des Browsers statt einer Seite, die sagt, was zu tun ist.
// Gemeldet wird deutlich, beendet wird nicht.

/** Die drei Stufen, absteigend nach Dringlichkeit. */
const STUFEN = ['fehlt', 'hinweis', 'gut'];

/**
 * @param {object} umgebung   process.env oder etwas, das so aussieht.
 * @param {object} [tatsachen]
 * @param {boolean} [tatsachen.datenOrdnerBeschreibbar]
 * @param {boolean} [tatsachen.freigabeVorhanden]
 * @returns {Array<{stufe: string, was: string, satz: string}>}
 */
function selbstpruefung(umgebung = {}, tatsachen = {}) {
  const befunde = [];
  const hat = (name) => Boolean(String(umgebung[name] || '').trim());

  // 1. Ohne diese beiden geht gar nichts.
  if (hat('ZOOM_CLIENT_ID') && hat('ZOOM_CLIENT_SECRET')) {
    befunde.push({
      stufe: 'gut',
      was: 'Zoom-Zugangsdaten',
      satz: 'ZOOM_CLIENT_ID und ZOOM_CLIENT_SECRET sind gesetzt.',
    });
  } else {
    const fehlende = ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'].filter((n) => !hat(n));
    befunde.push({
      stufe: 'fehlt',
      was: 'Zoom-Zugangsdaten',
      satz:
        `${fehlende.join(' und ')} fehlt. Ohne diese Angabe kann CueLight ` +
        'keinem Meeting beitreten. Sie stehen in der eigenen Zoom-App unter ' +
        '"App Credentials" - siehe README, Schritt 1.',
    });
  }

  // 2. Das Passwort. Kein Fehler, aber eine Entscheidung, die jemand
  //    getroffen haben muss - und zu oft ist sie nicht getroffen, sondern
  //    vergessen worden.
  if (hat('CUELIGHT_PASSWORD')) {
    befunde.push({
      stufe: 'gut',
      was: 'Passwortschutz',
      satz: 'Beim ersten Aufruf fragt CueLight einmal nach dem Passwort.',
    });
  } else {
    befunde.push({
      stufe: 'hinweis',
      was: 'Passwortschutz',
      satz:
        'CUELIGHT_PASSWORD ist leer - wer die Adresse kennt, kann CueLight ' +
        'benutzen. In Ordnung im Heimnetz oder hinter einer eigenen ' +
        'Zugriffskontrolle; aus dem Internet erreichbar bitte setzen.',
    });
  }

  // 3. Die zweite Stufe.
  befunde.push(
    hat('CUELIGHT_ADMIN_PASSWORD')
      ? {
          stufe: 'gut',
          was: 'Admin-Passwort',
          satz: 'Die Zoom-Freigabe verlangt zusaetzlich das Admin-Passwort.',
        }
      : {
          stufe: 'hinweis',
          was: 'Admin-Passwort',
          satz:
            'CUELIGHT_ADMIN_PASSWORD ist leer - wer CueLight bedienen darf, ' +
            'darf auch bestimmen, in wessen Namen es Meetings beitritt. Fuer ' +
            'eine Instanz mit einem Bediener in Ordnung.',
        }
  );

  // 4. Der Ordner, in dem die Freigabe liegt. Ist er nicht beschreibbar,
  //    laesst sich zwar alles einrichten - aber nach dem naechsten
  //    Neustart ist die Freigabe weg, und niemand weiss warum.
  if (tatsachen.datenOrdnerBeschreibbar === false) {
    befunde.push({
      stufe: 'fehlt',
      was: 'Datenverzeichnis',
      satz:
        '/app/data ist nicht beschreibbar. Die Zoom-Freigabe laesst sich dann ' +
        'zwar erteilen, ueberlebt aber keinen Neustart. Auf dem Host hilft ' +
        'meist: chown -R 1000:1000 ./data',
    });
  }

  // 5. Und schliesslich: Ist ueberhaupt schon freigegeben?
  if (tatsachen.freigabeVorhanden === false) {
    befunde.push({
      stufe: 'hinweis',
      was: 'Zoom-Freigabe',
      satz:
        'Noch keine Freigabe erteilt. Einmalig /oauth/authorize aufrufen und ' +
        'sich mit dem Zoom-Konto anmelden, dem die Meetings gehoeren.',
    });
  }

  return befunde;
}

/** Sortiert nach Dringlichkeit und formt einen Block fuer das Protokoll. */
function berichtAlsText(befunde) {
  const zeichen = { fehlt: 'FEHLT  ', hinweis: 'Hinweis', gut: 'ok     ' };
  const sortiert = [...befunde].sort(
    (a, b) => STUFEN.indexOf(a.stufe) - STUFEN.indexOf(b.stufe)
  );

  const zeilen = ['', '--- CueLight: Selbstpruefung ---'];
  for (const b of sortiert) {
    zeilen.push(`[${zeichen[b.stufe] || b.stufe}] ${b.was}: ${b.satz}`);
  }

  const offen = sortiert.filter((b) => b.stufe === 'fehlt').length;
  zeilen.push(
    offen === 0
      ? '--- Nichts Dringendes offen. ---'
      : `--- ${offen} Punkt(e) muessen erledigt werden, sonst laeuft CueLight nicht. ---`,
    ''
  );
  return zeilen.join('\n');
}

module.exports = { selbstpruefung, berichtAlsText, STUFEN };
