<p align="center">
  <img src="assets/logo.png" width="160" alt="CueLight Logo" />
</p>

# CueLight für Zoom

[![Docker-Image veröffentlichen](https://github.com/derbredi/cuelight/actions/workflows/publish.yml/badge.svg)](https://github.com/derbredi/cuelight/actions/workflows/publish.yml)

**Wortmeldungen aus einem Zoom-Meeting, groß genug, um sie aus dem
Augenwinkel zu sehen.**

Wer vor Publikum spricht und nebenbei Zuhörer aus Zoom dazunehmen will,
hat ein Problem: Das kleine gelbe Handzeichen in der Teilnehmerliste sieht
man nur, wenn man direkt hinschaut. CueLight zeigt stattdessen auf einem
Tablet oder Bildschirm jede gehobene Hand als große, blinkende Kachel mit
dem Namen – auffällig genug, dass man sie mitten im Satz bemerkt.

Ein Tipp auf eine Kachel schaltet die Person frei, sodass sie sofort
sprechen kann.

<p align="center">
  <img src="assets/demo.gif" width="330" alt="Wortmeldungen erscheinen als große, blinkende Kacheln; die dritte wird freigeschaltet, springt nach vorn und färbt sich grün" />
</p>

## Was du brauchst

- **Einen Rechner mit Docker**, der während der Veranstaltung läuft. Ein
  Raspberry Pi oder ein NAS reicht völlig.
- **Eine Adresse mit `https://`.** Ohne Verschlüsselung lässt Zoom keinen
  Beitritt zu – das gilt für jedes Gerät, auch für ein nagelneues. Der
  nächste Abschnitt zeigt, wie du dazu kommst.
- **Ein Zoom-Konto**, unter dem die Meetings stattfinden.
- **Ein Anzeigegerät** mit einem einigermaßen aktuellen Browser: Tablet,
  Laptop oder ein Bildschirm am Rechner. Zoom unterstützt die aktuelle
  Browser-Version und zwei vorherige. Ob ein älteres Gerät noch mitmacht,
  klärt der Test unter „Wenn etwas nicht klappt".

CueLight tritt dem Meeting als eigener, stummer Teilnehmer bei. Auf dem
Rechner, der das Meeting hostet, muss nichts installiert werden.

## Eine Adresse mit https einrichten

CueLight verschlüsselt nicht selbst – das übernimmt etwas, das davor
sitzt. Zwei verbreitete Wege:

- **Cloudflare Tunnel** (`cloudflared`): Braucht keine offenen Ports am
  Router und bringt das Zertifikat mit. Zu Hause meist der bequemste Weg.
- **Ein Reverse-Proxy** wie Caddy, nginx Proxy Manager oder Traefik mit
  einem Zertifikat von Let's Encrypt.

Beide Wege setzen eine eigene Domain voraus. Zum ersten Ausprobieren geht
es auch ohne: Direkt auf dem Server selbst funktioniert
`http://localhost:4000`, weil der Browser die eigene Maschine als sicher
behandelt.

## Einrichten

### 1. Zoom-App anlegen

Einmalig, kostenlos, dauert fünf Minuten. Melde dich dafür mit dem
Zoom-Konto an, unter dem die Meetings später laufen – CueLight kann nur
Meetings dieses Kontos beitreten.

1. Auf [marketplace.zoom.us](https://marketplace.zoom.us) anmelden.
2. **Develop → Build App → General App** anlegen.
3. Unter **Features → Embed** das **Meeting SDK** einschalten.
4. Unter **Scopes** den Eintrag `user:read:token` hinzufügen.
5. Als **Redirect-URL** die Adresse eintragen, unter der CueLight später
   erreichbar ist, mit `/oauth/callback` am Ende:
   `https://deine-domain.de/oauth/callback`.
6. Unter **App Credentials** stehen **Client ID** und **Client Secret**.
   Diese beiden Werte brauchst du gleich.

Die App muss nicht veröffentlicht werden.

### 2. CueLight starten

```bash
mkdir cuelight && cd cuelight
curl -O https://raw.githubusercontent.com/derbredi/cuelight/main/docker-compose.yml
nano docker-compose.yml   # Client ID und Client Secret eintragen
docker compose up -d
```

Mit **Portainer** geht es genauso: *Stacks → Add stack*, den Inhalt der
`docker-compose.yml` einfügen, die beiden Werte eintragen, *Deploy*.

Mehr als diese zwei Werte gibt es nicht einzustellen. Ob alles läuft,
zeigt `docker compose logs -f`.

### 3. Loslegen

Öffne auf dem Anzeigegerät deine Adresse – am besten vollständig mit
`https://` davor, weil manche Geräte sonst bei einer unverschlüsselten
Verbindung bleiben. Dann die Meeting-Nummer eintragen und auf **CueLight
starten** tippen.

Beim allerersten Mal erscheint ein blauer Knopf, der dich zu Zoom
schickt. Dort meldest du dich mit dem Konto an, das die Meetings hostet,
und gibst CueLight einmal frei. Das gilt danach dauerhaft.

## Bedienen

- **Kachel antippen** schaltet die Person frei. Dafür braucht CueLight im
  Meeting Host- oder Co-Host-Rechte – die gibst du ihm in der
  Zoom-Teilnehmerliste wie jedem anderen auch.
- **Alle Hände herunternehmen** erscheint unter der letzten Kachel.
- **Verlassen** ist der Knopf oben rechts. Danach bleibt CueLight im
  Formular stehen, bis du wieder selbst startest.
- Unter welchem Namen CueLight im Meeting auftaucht, legst du im Feld
  **Name im Meeting** fest. Bleibt es leer, heißt es „CueLight".
- Meeting-Nummer, Passwort und Name merkt sich CueLight auf dem Gerät.
  Legst du die Seite auf den Startbildschirm, ist sie beim nächsten
  Antippen sofort wieder im Meeting.
- Quer gehaltene Geräte zeigen die Meldungen nebeneinander in zwei
  Spalten.

### Wenn sich niemand meldet

Dann zeigt CueLight die Uhrzeit und wer im Meeting ist – in derselben
Reihenfolge wie Zoom selbst: Host, Co-Hosts, offene Mikrofone, danach
alphabetisch. Ein grüner Punkt markiert ein offenes Mikrofon, so siehst du
auch jemanden, der spricht, ohne die Hand gehoben zu haben. Sobald sich
jemand meldet, verschwindet die Ansicht.

Wenn auch Publikum auf den Bildschirm schauen kann, blendet `?namen=0` am
Ende der Adresse die Namen aus. CueLight merkt sich das; `?namen=1`
schaltet sie wieder ein. Die Teilnehmerzahl bleibt in beiden Fällen
stehen.

## Aus dem Internet erreichbar? Dann absichern

Wer CueLight öffnen kann, kann damit deinem Zoom-Meeting beitreten. Sobald
es also unter einer öffentlichen Adresse läuft, gehört ein Riegel davor.

**Der einfache Weg:** Trag in der `docker-compose.yml` bei
`CUELIGHT_PASSWORD` ein Passwort ein und starte den Container neu. Beim
ersten Aufruf fragt CueLight einmal danach und merkt sich die Anmeldung
ein Jahr lang.

**Hast du schon eine Zugriffskontrolle** – Cloudflare Access, einen
Reverse-Proxy mit Passwortschutz oder ein VPN –, dann lass
`CUELIGHT_PASSWORD` leer. Zweimal anmelden muss sich niemand.

## Betrieb

| Aufgabe | Befehl |
|---|---|
| Aktualisieren | `docker compose pull && docker compose up -d` |
| Stoppen | `docker compose down` |
| Protokoll ansehen | `docker compose logs -f` |

Nach einem Neustart des Servers startet CueLight von selbst wieder mit.

## Wenn etwas nicht klappt

**Der Beitritt schlägt fehl.** Gehört das Meeting zu demselben Zoom-Konto,
unter dem du die App angelegt hast? Meetings fremder Konten lässt Zoom
nicht zu.

**Der Beitritt hängt und bricht dann ab.** Steht in der Adresszeile
`https://`? Ohne Verschlüsselung fehlen dem Browser Funktionen, die Zoom
zwingend braucht. Ältere Geräte wechseln nicht von selbst auf `https://`,
dort also die Adresse vollständig eintippen.

**Auf einem Gerät passiert gar nichts.** Öffne dort `zoom.us/wc/join` und
tritt einem beliebigen Meeting bei – das benutzt dieselbe Technik wie
CueLight. Klappt das auch nicht, ist das Gerät zu alt, und CueLight kann
daran nichts ändern. Klappt es dagegen, liegt es nicht am Gerät: Dann
bitte ein Issue aufmachen, am besten mit dem, was `?debug=1` anzeigt
(siehe unten).

**Freischalten funktioniert nicht.** Dann hat CueLight im Meeting keine
Host- oder Co-Host-Rechte.

**Gehobene Hände tauchen nicht auf.** Zoom übermittelt das Handzeichen je
nach Kontotyp unterschiedlich. Öffne die Seite mit `?debug=1` am Ende der
Adresse: Dann schreibt CueLight mit, was Zoom über die Teilnehmer liefert.
Bitte öffne damit ein Issue, dann lässt sich die Erkennung ergänzen.

**Fehlersuche ohne Rechner.** `?debug=1` zeigt Fehlermeldungen auch unten
auf dem Bildschirm an – so kommst du auf einem Tablet an eine brauchbare
Meldung, ohne es an einen Computer anschließen zu müssen.

**Anderes Zoom-Konto nötig?** Zoom-Apps lassen sich nicht zwischen Konten
umziehen. Leg im neuen Konto eine App an (Schritt 1), trag die neuen Werte
in die `docker-compose.yml` ein, lösche die Datei
`data/zoom-oauth-tokens.json` und starte den Container neu.

## Mitmachen

Fehler gefunden oder eine Idee? Gerne ein Issue oder einen Pull Request
öffnen. Sicherheitslücken bitte nicht öffentlich, sondern wie in
[SECURITY.md](SECURITY.md) beschrieben melden.

Wer am Code etwas ändern möchte: Repo klonen, in der `docker-compose.yml`
`image:` durch `build: .` ersetzen und mit `docker compose up -d --build`
bauen.

Das Bild oben ist eine echte Aufnahme der laufenden Anwendung. Nach einer
Änderung an der Oberfläche lässt es sich neu erzeugen:

```bash
npm install --no-save playwright && npx playwright install chromium
node tools/screenshots.js
```

## Lizenz

[MIT](LICENSE) – frei nutzbar, auch kommerziell, ohne Gewähr.
