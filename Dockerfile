FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY public ./public
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA NODE_ENV=production HOST=0.0.0.0 PORT=8080 DB_PATH=/data/watch-queue.db
USER 568:568
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server.ts"]
