# Sicherheit

## Sicherheitslücke melden

Falls du eine Sicherheitslücke findest, bitte **keinen öffentlichen
GitHub-Issue** dafür anlegen. Melde es stattdessen direkt formlos per
E-Mail (Adresse im GitHub-Profil), damit es behoben werden kann, bevor
es öffentlich sichtbar ist.

## Was die Endpunkte tun

| Endpunkt | Gibt heraus | Risiko, wenn ungeschützt |
|---|---|---|
| `POST /api/signature` | kurzlebiges Beitritts-Token (Rolle: Teilnehmer) | Fremde könnten mit erratener Meeting-Nummer beitreten |
| `GET /api/obf-token` | Token, das gegenüber Zoom **im Namen des freigebenden Hosts** wirkt | deutlich sensibler als die Signatur |
| `GET /oauth/authorize` | startet die Freigabe | Fremde könnten die gespeicherte Freigabe überschreiben |

Deshalb: **`CUELIGHT_PASSWORD` setzen**, sobald die Instanz aus dem
Internet erreichbar ist — oder eine vorgelagerte Zugriffskontrolle
(Cloudflare Access, Basic Auth im Reverse-Proxy, nur im VPN erreichbar)
davorschalten. Eines von beidem genügt.

## Eingebaute Schutzmaßnahmen

- Passwort (`CUELIGHT_PASSWORD`) vor allen Routen, Vergleich in
  konstanter Zeit, Eingabe über eine Anmeldeseite, Ablage im Browser als
  `HttpOnly`-Cookie; Mengenlimit auf die Anmeldeversuche.
- OAuth mit `state`-Parameter gegen CSRF; die Instanz bindet sich beim
  ersten Mal automatisch an das freigebende Zoom-Konto und weist andere
  Konten danach ab.
- CORS abgeschaltet, Content-Security-Policy, `nosniff`,
  `frame-ancestors 'none'`, HSTS bei HTTPS.
- Mengenlimit auf `/api/signature` und `/api/obf-token`.
- Die Signatur wird immer mit Rolle 0 (Teilnehmer) ausgestellt; die
  Meeting-Nummer muss aus 9–12 Ziffern bestehen.
- `zoom-oauth-tokens.json` wird mit Rechten `0600` und atomar geschrieben
  und liegt ausschließlich im gebundenen Host-Verzeichnis, nie im
  Docker-Image oder im Git-Repo (siehe `.gitignore` / `.dockerignore`).

## Bekannte, bewusste Design-Entscheidungen

- Das Zoom Meeting SDK wird zur Laufzeit von `source.zoom.us` geladen
  (ohne Subresource Integrity, da Zoom die Dateien unter derselben URL
  aktualisiert). Wer das nicht möchte, kann `@zoom/meetingsdk` per npm
  einbinden und lokal ausliefern — das macht CueLight zugleich unabhängig
  davon, ob `source.zoom.us` im Moment des Auftritts erreichbar ist.
- Die Anwendung ist einmandantig: es gibt genau eine gespeicherte
  Host-Freigabe pro Instanz. Mehrere Gruppen betreiben je eine eigene
  Instanz.
