// Watch Queue: DB_PATH=watch-queue.db node src/server.ts, then open http://localhost:4747
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { Store } from "./store.ts";

const app = createApp({ store: new Store(config.DB_PATH), fetch, commit: config.GIT_SHA });
serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, () => console.log(`Watch Queue on ${config.BASE_URL}`));
