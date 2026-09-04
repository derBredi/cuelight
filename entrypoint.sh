#!/bin/sh
# Läuft beim Containerstart kurz als root, damit das gemountete
# Datenverzeichnis (egal welche Rechte es auf dem Host gerade hat)
# automatisch dem node-User gehört - danach wird sofort zu diesem
# unprivilegierten User gewechselt. Macht das manuelle "chown 1000:1000"
# auf dem Host überflüssig, das sonst leicht vergessen wird.
set -e
chown -R node:node /app/data
exec su-exec node "$@"
