'use strict';

// Wann laeuft ein Zoom-Zugangstoken ab?
//
// WARUM DAS EINE EIGENE DATEI IST: Der Ausdruck ist eine Zeile, aber er
// hatte einen Fehler, den man ihm nicht ansieht - und eine eigene Datei
// laesst sich pruefen, ohne den Server zu starten.
//
// DER FEHLER: In server.js stand zweimal
//
//     expires_at: Date.now() + data.expires_in * 1000
//
// Fehlt "expires_in" in Zooms Antwort oder ist es kein Zahlwert, ergibt
// die Multiplikation NaN, und Date.now() + NaN ist wieder NaN. Das allein
// waere noch harmlos - aber der Wert wird als JSON in die Token-Datei
// geschrieben, und JSON kennt kein NaN: Aus expires_at wird NULL.
//
// Beim naechsten Aufruf prueft der Server
//
//     const stillValid = tokens.expires_at && Date.now() < tokens.expires_at - 60_000;
//
// und null ist falsy. Das Token gilt also NIE als gueltig, und JEDE
// Anfrage loest eine Erneuerung bei Zoom aus. Zoom rotiert dabei das
// Refresh-Token jedes Mal. Ein Fehler, der sich nicht als Absturz zeigt,
// sondern als Freigabe, die irgendwann ohne erkennbaren Grund weg ist -
// und zwar mitten in einer Zusammenkunft, weil dort die Anfragen kommen.
//
// Dieselbe Stelle gab es in meldungen.app. Dort ist sie am 20.09.2026
// behoben worden; hier stand sie noch.
//
// WARUM EINE STUNDE ALS RUECKFALL: Zoom gibt fuer Zugangstoken seit jeher
// 3599 Sekunden aus. Ist die Angabe unbrauchbar, ist die Annahme "etwa
// eine Stunde" naeher an der Wahrheit als "sofort abgelaufen" - und im
// schlimmsten Fall wird einmal zu frueh erneuert statt bei jedem Aufruf.

const STANDARD_LEBENSDAUER_SEKUNDEN = 3600;

/**
 * @param {unknown} expiresIn Zooms Angabe in Sekunden, wie sie kommt.
 * @param {number} [jetzt]    Nur fuer Tests; sonst die aktuelle Zeit.
 * @returns {number} Zeitpunkt in Millisekunden, IMMER eine endliche Zahl.
 */
function ablaufZeitpunkt(expiresIn, jetzt = Date.now()) {
  const sekunden = Number(expiresIn);
  // Number.isFinite faengt NaN UND Infinity. Die Pruefung auf > 0 faengt
  // zusaetzlich die 0 und negative Werte - beide wuerden ein Token
  // ergeben, das schon bei der Geburt abgelaufen ist.
  const brauchbar = Number.isFinite(sekunden) && sekunden > 0;
  return jetzt + (brauchbar ? sekunden : STANDARD_LEBENSDAUER_SEKUNDEN) * 1000;
}

module.exports = { ablaufZeitpunkt, STANDARD_LEBENSDAUER_SEKUNDEN };
