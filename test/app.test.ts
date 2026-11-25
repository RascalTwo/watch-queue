import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import type { Fetch } from "../src/media.ts";
import { newSecret, Store } from "../src/store.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const image = (bytes: Uint8Array<ArrayBuffer> = PNG, type = "image/png") => new Response(bytes, { headers: { "content-type": type } });
const post = (thumbnail: string) => Response.json({ data: { attributes: { title: "Post", image: { large_url: thumbnail } } } });

/** The real app on a real SQLite database; `sites` is a fake internet that also records what was asked of it. */
function setup(sites: Record<string, () => Response> = {}) {
  const store = new Store(":memory:");
  const asked: string[] = [];
  const fetch: Fetch = async (url, init) => {
    asked.push(url);
    const answer = sites[url.split("?")[0] ?? ""]?.() ?? new Response("no", { status: 404 });
    const location = answer.headers.get("location");
    return location && init.redirect !== "manual" ? fetch(location, init) : answer; // as the real fetch does
  };
  const app = createApp({ store, fetch, commit: "abc" });
  const call = (secret: string | null, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...(secret && { Authorization: `Bearer ${secret}` }), "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const redeem = (code: string, secret: string) => call(null, "POST", "/api/invites/redeem", { code, secret });
  const join = async (name: string) => {
    const secret = newSecret();
    expect((await redeem(store.createInvite(name), secret)).status).toBe(200);
    return secret;
  };
  const save = (secret: string, version: number, items: unknown[], pile: unknown[] = []) =>
    call(secret, "PUT", "/api/list", { version, content: { items, pile, rules: "" } });
  const list = async (secret: string) => (await call(secret, "GET", "/api/list")).json();
  return { store, asked, call, redeem, join, save, list };
}

const item = (over: Record<string, unknown> = {}) => ({ id: randomUUID(), url: "https://example.com/a", source: "other", title: "A", tags: [], ...over });
const SAVED = "https://c10.patreonusercontent.com/old.png";
const patreonItem = (over: Record<string, unknown> = {}) =>
  item({ url: "https://www.patreon.com/posts/hello-123", source: "patreon", thumbnail: SAVED, ...over });
const API = "https://www.patreon.com/api/posts/123";

test("a stranger without a list is refused everything, and nothing is fetched for them", async () => {
  // GIVEN a server with someone else's list on it
  const { asked, call, join } = setup();
  await join("Sam");
  // WHEN a stranger calls every endpoint that needs a list
  const answers = await Promise.all([
    call(null, "GET", "/api/list"),
    call(newSecret(), "GET", "/api/list"),
    call(null, "PUT", "/api/list", { version: 1, content: { items: [], pile: [], rules: "" } }),
    call(null, "POST", "/api/list/secret", { secret: newSecret() }),
    call(null, "POST", "/api/meta", { url: "https://www.youtube.com/watch?v=a" }),
    call(newSecret(), "POST", "/api/meta", { url: "https://www.youtube.com/watch?v=a" }),
    call(newSecret(), "GET", `/api/thumb/${randomUUID()}`),
  ]);
  // THEN each is refused
  expect(answers.map((r) => r.status)).toEqual(Array(7).fill(401));
  // THEN the server contacted nobody
  expect(asked).toEqual([]);
});

test("an invite makes one list and is then used up", async () => {
  // GIVEN an invite that has been used
  const { store, redeem, call } = setup();
  const code = store.createInvite("Sam");
  const sam = newSecret();
  expect((await redeem(code, sam)).status).toBe(200);
  // WHEN someone else opens the same invite
  const other = newSecret();
  const second = await redeem(code, other);
  // THEN they are told it is used
  expect(second.status).toBe(410);
  expect(await second.json()).toEqual({ error: "This invite has already been used." });
  // THEN they have no list, and the first person still does
  expect((await call(other, "GET", "/api/list")).status).toBe(401);
  expect((await call(sam, "GET", "/api/list")).status).toBe(200);
});

test("repeating an invite with the same secret opens the same list", async () => {
  // GIVEN an invite whose first answer got lost on the way back
  const { store, redeem, save, list } = setup();
  const code = store.createInvite("Sam");
  const sam = newSecret();
  await redeem(code, sam);
  await save(sam, 1, [item({ title: "Kept" })]);
  // WHEN the same browser tries again
  const again = await redeem(code, sam);
  // THEN it works and the list is untouched
  expect(again.status).toBe(200);
  expect((await list(sam)).items[0].title).toBe("Kept");
});

test("a made-up invite, or one aimed at an existing list, makes nothing", async () => {
  // GIVEN someone who already has a list, and a fresh invite
  const { store, redeem, join } = setup();
  const sam = await join("Sam");
  const code = store.createInvite("Kim");
  // WHEN a made-up code is tried, and the fresh invite is tried with a secret already in use
  const madeUp = await redeem(newSecret(), newSecret());
  const taken = await redeem(code, sam);
  // THEN both are refused and the fresh invite still works
  expect([madeUp.status, taken.status]).toEqual([410, 410]);
  expect((await redeem(code, newSecret())).status).toBe(200);
});

test("one person can't read or change another person's list", async () => {
  // GIVEN two people with a list each
  const { join, save, list } = setup();
  const [sam, kim] = [await join("Sam"), await join("Kim")];
  await save(sam, 1, [item({ title: "Sam's" })]);
  // WHEN Kim saves
  await save(kim, 1, [item({ title: "Kim's" })]);
  // THEN each sees only their own items
  expect((await list(sam)).items.map((i: { title: string }) => i.title)).toEqual(["Sam's"]);
  expect((await list(kim)).items.map((i: { title: string }) => i.title)).toEqual(["Kim's"]);
});

test("a list can't be used to see another list's thumbnails", async () => {
  // GIVEN Sam has a Patreon item whose thumbnail is stored
  const { join, save, call } = setup({ [SAVED]: () => image() });
  const [sam, kim] = [await join("Sam"), await join("Kim")];
  const it = patreonItem();
  await save(sam, 1, [it]);
  expect((await call(sam, "GET", `/api/thumb/${it.id}`)).status).toBe(200);
  // WHEN Kim asks for it by its id
  const answer = await call(kim, "GET", `/api/thumb/${it.id}`);
  // THEN Kim is refused
  expect(answer.status).toBe(404);
});

test("a save from an out-of-date page changes nothing and returns the latest list", async () => {
  // GIVEN a list open in two tabs, and a save from the first
  const { join, save, list } = setup();
  const sam = await join("Sam");
  expect(await (await save(sam, 1, [item({ title: "First tab" })])).json()).toEqual({ version: 2 });
  // WHEN the second tab saves over the version it last saw
  const stale = await save(sam, 1, []);
  // THEN it is told, and given the latest list
  expect(stale.status).toBe(409);
  expect((await stale.json()).items[0].title).toBe("First tab");
  // THEN nothing was lost
  expect((await list(sam)).items).toHaveLength(1);
});

test("a new link replaces the old one", async () => {
  // GIVEN someone with a list
  const { join, call } = setup();
  const old = await join("Sam");
  // WHEN they make a new link
  const fresh = newSecret();
  expect((await call(old, "POST", "/api/list/secret", { secret: fresh })).status).toBe(200);
  // THEN only the new one opens the list
  expect((await call(old, "GET", "/api/list")).status).toBe(401);
  expect((await call(fresh, "GET", "/api/list")).status).toBe(200);
});

test("a list that was switched off can't be used until it is switched back on", async () => {
  // GIVEN a list
  const { store, join, call, asked } = setup();
  const sam = await join("Sam");
  const id = store.open(sam)?.id ?? "";
  // WHEN it is switched off
  store.setDisabled(id, true);
  // THEN it can't be read or used to fetch
  expect((await call(sam, "GET", "/api/list")).status).toBe(403);
  expect((await call(sam, "POST", "/api/meta", { url: "https://youtu.be/a" })).status).toBe(403);
  expect(asked).toEqual([]);
  // WHEN it is switched back on
  store.setDisabled(id, false);
  // THEN it works
  expect((await call(sam, "GET", "/api/list")).status).toBe(200);
});

test("a dead Patreon image is replaced, kept, and deleted with its item", async () => {
  // GIVEN a Patreon item whose saved image link has expired
  const fresh = "https://c10.patreonusercontent.com/new.png";
  const { store, join, save, call, asked } = setup({ [API]: () => post(fresh), [fresh]: () => image() });
  const sam = await join("Sam");
  const it = patreonItem();
  await save(sam, 1, [it]);
  // WHEN its thumbnail is shown twice
  const first = await call(sam, "GET", `/api/thumb/${it.id}`);
  const fetches = asked.length;
  const second = await call(sam, "GET", `/api/thumb/${it.id}`);
  // THEN both show the fresh image, and the second needed no fetch
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG);
  expect(new Uint8Array(await second.arrayBuffer())).toEqual(PNG);
  expect(asked).toHaveLength(fetches);
  expect(store.lists()[0]).toMatchObject({ thumbs: 1 });
  // WHEN the item is removed
  await save(sam, 2, []);
  // THEN the stored image is gone
  expect(store.lists()[0]).toMatchObject({ thumbs: 0 });
});

test.each([
  ["a home network address", "http://192.168.1.1/"],
  ["the server itself", "https://127.0.0.1/"],
  ["another site", "https://evil.example/x.png"],
  ["a lookalike host", "https://patreonusercontent.com.evil.example/x.png"],
  ["an unencrypted link", "http://c10.patreonusercontent.com/x.png"],
  ["a link carrying a password", "https://a:b@c10.patreonusercontent.com/x.png"],
  ["an odd port", "https://c10.patreonusercontent.com:8443/x.png"],
])("a thumbnail pointing at %s is never fetched", async (_, thumbnail) => {
  // GIVEN a Patreon item whose thumbnail points somewhere it shouldn't
  const { join, save, call, asked } = setup();
  const sam = await join("Sam");
  const it = patreonItem({ thumbnail });
  await save(sam, 1, [it]);
  // WHEN the thumbnail is asked for
  const answer = await call(sam, "GET", `/api/thumb/${it.id}`);
  // THEN only Patreon was contacted
  expect(answer.status).toBe(502);
  expect(asked.map((u) => new URL(u).hostname)).toEqual(["www.patreon.com"]);
});

test("a redirect off the allowed sites is not followed", async () => {
  // GIVEN an allowed image host that redirects to the home network
  const away = () => new Response(null, { status: 302, headers: { location: "http://192.168.1.1/secret" } });
  const { join, save, call, asked } = setup({ [SAVED]: away });
  const sam = await join("Sam");
  const it = patreonItem();
  await save(sam, 1, [it]);
  // WHEN the thumbnail is asked for
  const answer = await call(sam, "GET", `/api/thumb/${it.id}`);
  // THEN the redirect went nowhere
  expect(answer.status).toBe(502);
  expect(asked.some((u) => u.includes("192.168"))).toBe(false);
});

test("an item removed while its image downloads leaves no image behind", async () => {
  // GIVEN an image host slow enough for the item to be removed meanwhile
  const ctx: ReturnType<typeof setup> = setup({ [SAVED]: () => { ctx.store.save(id, 2, { items: [], pile: [], rules: "" }); return image(); } });
  const sam = await ctx.join("Sam");
  const id = ctx.store.open(sam)?.id ?? "";
  const it = patreonItem();
  await ctx.save(sam, 1, [it]);
  // WHEN its thumbnail is shown
  await ctx.call(sam, "GET", `/api/thumb/${it.id}`);
  // THEN no image is stored
  expect(ctx.store.lists()[0]).toMatchObject({ items: 0, thumbs: 0 });
});

test.each(["javascript:alert(1)", "file:///etc/passwd", "not a link"])("looking up %s is refused", async (url) => {
  // GIVEN someone with a list
  const { join, call } = setup();
  const sam = await join("Sam");
  // WHEN they look up something that isn't a web link
  const answer = await call(sam, "POST", "/api/meta", { url });
  // THEN it is refused
  expect(answer.status).toBe(400);
});

test.each([
  ["a page instead of an image", () => image(PNG, "text/html")],
  ["an SVG, which can hold scripts", () => image(PNG, "image/svg+xml")],
  ["an image over 5 MB", () => image(new Uint8Array(5_000_001))],
])("%s is not kept as a thumbnail", async (_, answer) => {
  // GIVEN an image link that answers with something unsuitable
  const { store, join, save, call } = setup({ [SAVED]: answer });
  const sam = await join("Sam");
  const it = patreonItem();
  await save(sam, 1, [it]);
  // WHEN the thumbnail is asked for
  const r = await call(sam, "GET", `/api/thumb/${it.id}`);
  // THEN it is refused and nothing is stored
  expect(r.status).toBe(502);
  expect(store.lists()[0]).toMatchObject({ thumbs: 0 });
});

test("details come from YouTube and Patreon, and any other site is never contacted", async () => {
  // GIVEN YouTube and Patreon
  const { join, call, asked } = setup({
    "https://www.youtube.com/oembed": () => Response.json({ title: "Vid", author_name: "Ann", thumbnail_url: "https://i.ytimg.com/vi/a/hqdefault.jpg" }),
    "https://www.youtube.com/watch": () => new Response('"lengthSeconds":"62"'),
    [API]: () => post(SAVED),
  });
  const sam = await join("Sam");
  const meta = async (url: string) => (await call(sam, "POST", "/api/meta", { url })).json();
  // WHEN links are looked up
  // THEN each known site gives its details
  expect(await meta("https://www.youtube.com/watch?v=a")).toEqual({
    source: "youtube", title: "Vid", creator: "Ann", duration: 62, thumbnail: "https://i.ytimg.com/vi/a/hqdefault.jpg",
  });
  expect(await meta("https://www.patreon.com/posts/hello-123")).toEqual({ source: "patreon", title: "Post", thumbnail: SAVED });
  // THEN other addresses are left alone
  const before = asked.length;
  expect(await meta("http://192.168.1.1/admin")).toEqual({ source: "other" });
  expect(await meta("https://youtube.com.evil.example/watch?v=a")).toEqual({ source: "other" });
  expect(asked).toHaveLength(before);
});

test.each([
  ["a script link", [item({ url: "javascript:alert(1)" })]],
  ["a script thumbnail", [item({ thumbnail: "javascript:alert(1)" })]],
  ["an id that could break out of the page", [item({ id: '"><script>' })]],
  ["more than 500 items", Array.from({ length: 501 }, () => item())],
  ["the same id twice", [item({ id: "8a4c2f0e-58a5-4c39-9a52-0a2b6c5f1d11" }), item({ id: "8a4c2f0e-58a5-4c39-9a52-0a2b6c5f1d11" })]],
])("a list with %s is refused", async (_, items) => {
  // GIVEN someone with a list
  const { join, save, list } = setup();
  const sam = await join("Sam");
  // WHEN they save it
  const answer = await save(sam, 1, items);
  // THEN it is refused and nothing changed
  expect(answer.status).toBe(400);
  expect((await list(sam)).items).toEqual([]);
});

test("a request over 2 MB is refused", async () => {
  // GIVEN someone with a list
  const { join, call } = setup();
  const sam = await join("Sam");
  // WHEN they send too much
  const answer = await call(sam, "PUT", "/api/list", { version: 1, content: { items: [], pile: [], rules: "x".repeat(2_000_001) } });
  // THEN it is refused
  expect(answer.status).toBe(413);
});

test("a malformed request is a 400, not a crash", async () => {
  // GIVEN someone with a list
  const { join, call } = setup();
  const sam = await join("Sam");
  // WHEN they send something that isn't a save
  const answer = await call(sam, "PUT", "/api/list", "nope");
  // THEN it is refused
  expect(answer.status).toBe(400);
});
