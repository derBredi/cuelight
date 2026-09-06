<p align="center">
  <img src="assets/logo.png" width="160" alt="CueLight Logo" />
</p>

# CueLight für Zoom

[![Docker-Image veröffentlichen](https://github.com/derbredi/cuelight/actions/workflows/publish.yml/badge.svg)](https://github.com/derbredi/cuelight/actions/workflows/publish.yml)

Ein großes, blinkendes Display, das nur die Zoom-Teilnehmer zeigt, die
gerade die Hand heben – gedacht für Bühnenvorträge, wo ein kleines
Tablet neben dem Pult zu leicht übersehen wird. Läuft komplett
eigenständig: tritt dem Meeting selbst als unsichtbarer Teilnehmer bei,
braucht dafür nur eine Internetverbindung und die Meeting-Nummer -
kein Zugriff auf den Rechner, der das Meeting hostet, nötig.

## Wie es funktioniert

1. `server.js` ist ein winziger Server, der eine gültige **Meeting-SDK-Signatur**
   ausstellt (ein JWT). Deine Zoom-Zugangsdaten bleiben dabei immer auf dem
   Server, nie im Browser sichtbar.
2. `public/index.html` tritt deinem laufenden Zoom-Meeting als **unsichtbarer,
   stummer Teilnehmer** bei (kein Video, kein Audio) und liest laufend die
   Teilnehmerliste aus.
3. Wer die Hand hebt, erscheint groß, mit Blink-Effekt, im Display. Wer sie senkt
   oder das Meeting verlässt, verschwindet automatisch wieder.

## Wichtige Einschränkung – bitte zuerst testen

Zooms eigene Dokumentation ist an dieser Stelle uneinheitlich: Manche
Entwickler berichten, dass die Teilnehmerliste (`getAttendeeslist`) ein klares
Feld für "Hand gehoben" enthält, andere melden, dass es fehlt. CueLight prüft
deshalb mehrere bekannte Feldnamen und **loggt zusätzlich jedes rohe
Teilnehmer-Objekt in die Browser-Konsole (F12)**. Mach vor dem eigentlichen
Bühneneinsatz unbedingt einen Testlauf mit zwei Personen (eine hebt die Hand),
schau in die Konsole und prüfe, ob und unter welchem Feldnamen sich der
Zustand ändert. Falls keins der geprüften Felder anschlägt, öffne ein Issue
mit dem, was in der Konsole für das Objekt auftaucht - dann lässt sich
`isHandRaised()` in `public/index.html` entsprechend anpassen.

## 1. Zoom-App anlegen (einmalig, kostenlos, pro Zoom-Konto)

Jede Gruppe/jedes Zoom-Konto, das CueLight nutzen will, braucht eine
**eigene** kleine Zoom-App - das ist kostenlos und dauert 5 Minuten, es
ist kein Marketplace-Review nötig, solange CueLight nur Meetings des
eigenen Kontos beitritt (siehe "Bekannte Einschränkungen").

1. Bei [marketplace.zoom.us](https://marketplace.zoom.us) mit dem
   Zoom-Konto einloggen, das später die Meetings hostet.
2. „Develop" → „Build App" → **General App** anlegen.
3. Unter „Features" → „Embed" das **Meeting SDK** aktivieren. Unter
   „App Credentials" stehen dann **Client ID** und **Client Secret** -
   das sind die beiden einzigen Werte, die CueLight braucht.
4. Redirect-URL auf `https://deine-domain.de/oauth/callback` setzen
   (die Domain, unter der CueLight später erreichbar sein wird). Läuft
   CueLight nur im Heimnetz, gehört hier `http://IP-DES-SERVERS:4000/oauth/callback`
   hinein.
5. Scope `user:read:token` hinzufügen.
6. Muss nicht veröffentlicht werden - für den Eigengebrauch reicht der
   Entwicklungsmodus.

## 2. CueLight starten

```bash
mkdir cuelight && cd cuelight
curl -O https://raw.githubusercontent.com/derbredi/cuelight/main/docker-compose.yml
nano docker-compose.yml   # Client ID und Client Secret aus Schritt 1 eintragen
docker compose up -d
```

Mit Portainer geht es genauso: „Stacks" → „Add stack" → den Inhalt der
`docker-compose.yml` einfügen, die beiden Werte eintragen, „Deploy".

Es gibt nur zwei Pflichtfelder, `ZOOM_CLIENT_ID` und `ZOOM_CLIENT_SECRET`.
Alles andere hat brauchbare Voreinstellungen. Keine `.env`-Datei, keine
weitere Konfiguration.

Prüfen, ob es läuft:
```bash
docker compose logs -f
```
Es sollte „Signature-Server laeuft auf http://localhost:4000" erscheinen.

**Eigene Anpassungen am Code?** Statt `image:` in der `docker-compose.yml`
kannst du auch `build: .` eintragen und das Repo klonen
(`git clone https://github.com/derbredi/cuelight.git`) - dann baut
`docker compose up -d --build` dein eigenes Image aus dem lokalen Code.

## 3. CueLight öffnen

Auf dem Gerät, das später die Bühnenanzeige zeigt (Tablet, Laptop, …),
`http://IP-DES-SERVERS:4000` bzw. die eigene Domain öffnen.
Meeting-Nummer eingeben, „CueLight starten" - fertig. Beim ersten Mal
schickt dich CueLight einmal zu Zoom, damit der Meeting-Host die App
freigibt; das gilt danach dauerhaft. Für den schnellen Wiedereinstieg
lohnt sich der generierte Lesezeichen-Link (startet direkt, ohne erneute
Eingabe).

## Laufender Betrieb

- **Update auf neue Version**: `docker compose pull && docker compose up -d`
  (bzw. `docker compose up -d --build` bei eigenem Build, siehe oben)
- **Stoppen**: `docker compose down`
- **Logs ansehen**: `docker compose logs -f`
- Der Container startet dank `restart: unless-stopped` nach einem
  Server-Neustart automatisch wieder mit.

## Zugriff absichern, sobald CueLight aus dem Internet erreichbar ist

Im Heimnetz kannst du das überspringen. Sobald CueLight aber unter einer
öffentlichen Adresse läuft, sollte nicht jeder hineinkommen: CueLight
stellt Beitritts-Token für dein Zoom-Konto aus.

**Der einfache Weg:** In der `docker-compose.yml` bei `CUELIGHT_PASSWORD`
ein Passwort eintragen und den Container neu starten. Beim ersten Aufruf
fragt CueLight einmal danach, der Browser bietet an, es zu speichern, und
merkt sich die Anmeldung ein Jahr. Auf dem Bühnengerät machst du das also
genau einmal.

**Falls du schon eine Zugriffskontrolle hast:** Wer einen Cloudflare
Tunnel, einen Reverse-Proxy mit Basic-Auth oder ein VPN wie Tailscale
davor hat, lässt `CUELIGHT_PASSWORD` leer - doppelt anmelden muss sich
niemand. Bei Cloudflare legst du dafür im Zero-Trust-Dashboard unter
„Access → Applications" eine Application für die Subdomain an, mit einer
Policy wie „nur diese E-Mail-Adressen dürfen rein".

Zwei Dinge regelt CueLight von selbst, ohne Konfiguration: Das erste
Zoom-Konto, das die App freigibt, gehört ab dann zu dieser Instanz -
ein anderes Konto wird abgewiesen. Und die Seite lässt sich nicht in
fremde Websites einbetten.

## App auf ein anderes Zoom-Konto umziehen

Zoom SDK-Apps lassen sich **nicht** zwischen zwei Zoom-Konten übertragen
(kein Verschiebe-Button, offiziell bestätigt in Zooms Doku). Es bleibt
nur, die App im Zielkonto neu anzulegen (Schritt 1 dieser README
wiederholen, dann):

1. Neue **Client ID** + **Client Secret** notieren.
2. In der `docker-compose.yml` `ZOOM_CLIENT_ID` und `ZOOM_CLIENT_SECRET`
   durch die neuen Werte ersetzen.
3. Alte `zoom-oauth-tokens.json` im gebundenen Datenverzeichnis löschen
   (gehört zur alten App, ist nutzlos) und den Container neu starten.
4. Einmal neu unter `/oauth/authorize` mit dem Meeting-Host-Account
   autorisieren.

## Bekannte Einschränkungen

- CueLight belegt einen zusätzlichen Teilnehmerplatz im Meeting.
- Läuft der Server nicht mehr (z. B. Laptop zu), verliert CueLight die
  Verbindung - für einen wichtigen Vortrag lohnt sich ein kurzer Trockenlauf
  vorher.
- Je nach Zoom-Kontotyp (Basic/Pro/Business) können SDK-Funktionen leicht
  variieren.
- **Die App kann nur Meetings beitreten, die zum selben Zoom-Konto gehören,
  unter dem sie angelegt wurde.** Bei einem Meeting eines anderen
  Zoom-Kontos (Fehlercode `NOT_ALLOW_CROSS_JOIN` bzw. sofortiger
  Verbindungsabbruch nach dem Beitritt) hilft nur entweder das Meeting über
  das eigene Konto laufen zu lassen, oder die App durch Zooms vollen
  Marketplace-Review veröffentlichen zu lassen (aufwendig - siehe Zoom
  Developer Docs "Meeting SDK apps now require review to join meetings
  outside their own account"). **Deshalb: jede Gruppe betreibt am besten
  ihre eigene CueLight-Instanz mit ihrem eigenen Zoom-Konto (siehe Schritt 1)
  statt eine gemeinsame Instanz kontoübergreifend zu nutzen.**
- Entstummen einzelner Personen und "Alle Hände herunternehmen" brauchen
  Host- oder Co-Host-Rechte von CueLight im jeweiligen Meeting.

## Falls es nicht zuverlässig funktioniert

Falls sich herausstellt, dass Zoom das Handzeichen über die Attendee-Liste
bei dir gar nicht sauber liefert, ist der robusteste Fallback weiterhin eine
zweite Person, die die normale Zoom-Teilnehmerliste im Blick behält und dir
ein Zeichen gibt - technisch unspektakulär, aber 100 % zuverlässig.

## Mitmachen

Fehler gefunden oder eine Idee? Gerne ein Issue oder einen Pull Request
öffnen. Sicherheitslücken bitte nicht als öffentliches Issue, sondern
gemäß [SECURITY.md](SECURITY.md) melden.

## Lizenz

[MIT](LICENSE) - frei nutzbar, auch kommerziell, ohne Gewähr.
