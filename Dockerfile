# Kleines, produktionsnahes Image
FROM node:20-alpine

# su-exec: winziges Tool, um beim Containerstart kontrolliert von root zu
# einem unprivilegierten User zu wechseln (siehe entrypoint.sh).
# Bewusst ganz oben: so bricht dieser Layer nicht bei jeder Code-Aenderung.
RUN apk add --no-cache su-exec

ENV NODE_ENV=production

WORKDIR /app

# Erst die Manifeste, damit die Installation gecacht bleibt, solange sich
# nur der Code aendert. "npm ci" statt "npm install": installiert exakt die
# Versionen aus der package-lock.json, dadurch ist der Build reproduzierbar.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Restlichen Code kopieren
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Bewusst KEIN "USER node" hier: der Container startet als root, damit das
# Entrypoint-Skript die Rechte des gemounteten Datenverzeichnisses selbst
# korrigieren kann, egal welche Rechte es auf dem Host mitbringt - dann
# wechselt es sofort zum unprivilegierten node-User, bevor die App startet.
ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
