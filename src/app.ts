import { readFileSync } from "node:fs";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import { type Fetch, mediaFrom, MediaError } from "./media.ts";
import { Content, Secret } from "./schema.ts";
import type { List, Store } from "./store.ts";

type Env = { Variables: { list: List } };

const asset = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });

const Problem = z.object({ error: z.string() });
const Ok = z.object({ ok: z.literal(true) });
const ListBody = z.object({ name: z.string(), version: z.number(), items: z.array(z.any()), pile: z.array(z.any()), rules: z.string() });

const view = (l: List) => ({ name: l.name, version: l.version, ...l.content });

export function createApp({ store, fetch, commit }: { store: Store; fetch: Fetch; commit: string }) {
  const media = mediaFrom(fetch);
  const page = asset("index.html");
  const script = asset("app.js");

  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (result.success) return undefined;
      const issue = result.error.issues[0];
      return c.json({ error: issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request" }, 400);
    },
  });

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'unsafe-inline'"],
        imgSrc: ["'self'", "https:", "http:", "data:", "blob:"],
        connectSrc: ["'self'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: "no-referrer",
    }),
  );
  app.use("/api/*", bodyLimit({ maxSize: 2_000_000, onError: (c) => c.json({ error: "Too much data" }, 413) }));
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.header("Cache-Control", "no-store");
  });

  app.onError((e, c) => {
    if (e instanceof MediaError) return c.json({ error: e.message }, 502);
    if ("status" in e && typeof e.status === "number" && e.status < 500) return c.json({ error: "Invalid request" }, 400);
    console.error(e);
    return c.json({ error: "Something went wrong" }, 500);
  });

  app.get("/", (c) => c.html(page));
  app.get("/app.js", (c) => c.body(script, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" }));

  app.openapi(
    createRoute({ method: "get", path: "/api/health", responses: { 200: json(z.object({ commit: z.string() }), "Up") } }),
    (c) => c.json({ commit }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/invites/redeem",
      request: body(z.object({ code: Secret, secret: Secret })),
      responses: { 200: json(Ok, "The list exists and opens with the secret"), 400: json(Problem, "Bad request"), 410: json(Problem, "Unusable invite") },
    }),
    (c) => {
      const { code, secret } = c.req.valid("json");
      const result = store.redeem(code, secret);
      if (result === "ok") return c.json({ ok: true as const }, 200);
      return c.json({ error: result === "used" ? "This invite has already been used." : "This invite isn't valid." }, 410);
    },
  );

  // Everything below needs a list's secret. The list always comes from here, never from the request.
  const owner = createMiddleware<Env>(async (c, next) => {
    const secret = /^Bearer ([\w-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
    const list = secret ? store.open(secret) : undefined;
    if (!list) return c.json({ error: "No list with that link." }, 401);
    if (list.disabled) return c.json({ error: "This list has been switched off." }, 403);
    c.set("list", list);
    return next();
  });
  const denied = { 400: json(Problem, "Bad request"), 401: json(Problem, "No such list"), 403: json(Problem, "Switched off") };

  app.openapi(
    createRoute({ method: "get", path: "/api/list", middleware: [owner] as const, responses: { 200: json(ListBody, "The list"), ...denied } }),
    (c) => c.json(view(c.get("list")), 200),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/api/list",
      middleware: [owner] as const,
      request: body(z.object({ version: z.number().int(), content: Content })),
      responses: {
        200: json(z.object({ version: z.number() }), "Saved"),
        409: json(ListBody, "Changed elsewhere; nothing saved, here is the current list"),
        ...denied,
      },
    }),
    (c) => {
      const { version, content } = c.req.valid("json");
      const saved = store.save(c.get("list").id, version, content);
      return saved === undefined ? c.json(view(c.get("list")), 409) : c.json({ version: saved }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/list/secret",
      middleware: [owner] as const,
      request: body(z.object({ secret: Secret })),
      responses: { 200: json(Ok, "The old link no longer works"), ...denied },
    }),
    (c) => {
      store.replaceSecret(c.get("list").id, c.req.valid("json").secret);
      return c.json({ ok: true as const }, 200);
    },
  );

  // POST so the links people add never land in access logs
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/meta",
      middleware: [owner] as const,
      request: body(z.object({ url: z.url({ protocol: /^https?$/ }).max(4000) })),
      responses: { 200: json(z.any(), "What the site says about the link"), 502: json(Problem, "The site didn't answer"), ...denied },
    }),
    async (c) => c.json(await media.meta(c.req.valid("json").url), 200),
  );

  app.get("/api/thumb/:id", owner, async (c) => {
    const list = c.get("list");
    const item = [...list.content.items, ...list.content.pile].find((i) => i.id === c.req.param("id"));
    if (item?.source !== "patreon" || !item.thumbnail) return c.json({ error: "No such thumbnail" }, 404);
    let bytes = store.thumb(list.id, item.id, item.thumbnail);
    if (!bytes) {
      bytes = new Uint8Array(await media.patreonThumb(item.url, item.thumbnail));
      store.saveThumb(list.id, item.id, item.thumbnail, bytes);
    }
    // browsers sniff the real image format; naming an image type means it can never run as a page
    return c.body(bytes, 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", Vary: "Authorization" });
  });

  return app;
}
