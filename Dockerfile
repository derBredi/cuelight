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

# Läuft standardmäßig nicht als root. node:20-alpine bringt bereits einen
# fertigen User "node" mit fester UID/GID 1000 mit - den nutzen wir direkt,
# statt einen eigenen anzulegen (der würde mit UID 1000 kollidieren).
# Host-Verzeichnisse für Bind-Mounts entsprechend auf 1000:1000 chownen.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 4000

CMD ["node", "server.js"]
