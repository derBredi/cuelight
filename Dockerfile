# Kleines, produktionsnahes Image
FROM node:20-alpine

WORKDIR /app

# Nur package.json zuerst kopieren, damit npm install gecacht wird,
# solange sich der Code aendert aber die Abhaengigkeiten nicht
COPY package.json ./
RUN npm install --omit=dev

# Restlichen Code kopieren
COPY server.js ./
COPY public ./public

# su-exec: winziges Tool, um beim Containerstart kontrolliert von root zu
# einem unprivilegierten User zu wechseln (siehe entrypoint.sh).
RUN apk add --no-cache su-exec

RUN mkdir -p /app/data
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Bewusst KEIN "USER node" hier: der Container startet als root, damit das
# Entrypoint-Skript die Rechte des gemounteten Datenverzeichnisses selbst
# korrigieren kann, egal welche Rechte es auf dem Host mitbringt - dann
# wechselt es sofort zum unprivilegierten node-User, bevor die App startet.
ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 4000

CMD ["node", "server.js"]
