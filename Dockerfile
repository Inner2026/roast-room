FROM node:22-slim
WORKDIR /srv
COPY package.json ./
COPY app ./app
COPY config ./config
COPY .claude ./.claude
ENV NODE_ENV=production TRUST_PROXY=1 PORT=8080 DATABASE_FILE=/data/roastroom.db
RUN mkdir -p /data && chown -R node:node /data /srv
USER node
EXPOSE 8080
CMD ["node", "--no-warnings", "app/web.js"]
