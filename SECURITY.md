# Sicherheit

## Sicherheitslücke melden

Falls du eine Sicherheitslücke findest, bitte **keinen öffentlichen
GitHub-Issue** dafür anlegen. Melde es stattdessen direkt formlos per
E-Mail (Adresse im GitHub-Profil), damit es behoben werden kann, bevor
es öffentlich sichtbar ist.

## Bekannte, bewusste Design-Entscheidungen

- Der `/api/signature`-Endpunkt prüft selbst keine Authentifizierung -
  das ist bewusst so, weil er nur ein kurzlebiges Beitritts-Token
  ausstellt und für den Eigengebrauch hinter einem eigenen Reverse-Proxy
  mit Zugriffskontrolle laufen soll (siehe README, Abschnitt
  "Zugriff absichern"). **Nicht ohne eigene Zugriffskontrolle öffentlich
  ins Internet stellen.**
- Die OAuth-Zugangsdaten und das Token des Meeting-Hosts
  (`zoom-oauth-tokens.json`) liegen ausschließlich im gebindeten
  Host-Verzeichnis, nie im Docker-Image oder im Git-Repo (siehe
  `.gitignore` / `.dockerignore`).
