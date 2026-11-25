import { z } from "@hono/zod-openapi";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// The server sits on a home network, so it may only ever talk to these hosts.
const YOUTUBE = /^((www|m|music)\.)?youtube\.com$|^youtu\.be$/;
const PATREON = /^(www\.)?patreon\.com$/;
const PATREON_IMAGES = /^([\w-]+\.)*patreonusercontent\.com$|^image\.mux\.com$|^(www\.)?patreon\.com$/;

const PAGE_BYTES = 5_000_000;
const IMAGE_BYTES = 5_000_000;

export class MediaError extends Error {}

const allowed = (u: URL, hosts: RegExp) => u.protocol === "https:" && u.port === "" && u.username === "" && hosts.test(u.hostname);

/** Fetches from `hosts` only, checking every redirect, with a time and size limit. */
async function fetchFrom(fetch: Fetch, hosts: RegExp, url: string, maxBytes: number) {
  const signal = AbortSignal.timeout(15_000);
  let next = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (!allowed(next, hosts)) throw new MediaError(`Not allowed to fetch from ${next.host}`);
    const r = await fetch(next.href, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "manual", signal });
    const location = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && location) {
      await r.body?.cancel();
      next = new URL(location, next);
      continue;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new MediaError(`${next.hostname} answered ${r.status}`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of r.body ?? []) {
      size += chunk.length;
      if (size > maxBytes) throw new MediaError(`${next.hostname} sent too much data`);
      chunks.push(chunk);
    }
    return { type: r.headers.get("content-type") ?? "", bytes: Buffer.concat(chunks) };
  }
  throw new MediaError("Too many redirects");
}

const text = (s: unknown) => (typeof s === "string" && s ? s : undefined);

const OEmbed = z.object({ title: z.string(), author_name: z.string(), thumbnail_url: z.string() });

const attributes = z.record(z.string(), z.unknown());
const PatreonPost = z.object({
  data: z.object({ attributes }),
  included: z.array(z.object({ type: z.string(), attributes: attributes.optional() })).optional(),
});

export interface Meta {
  source: "youtube" | "patreon" | "other";
  title?: string | undefined;
  creator?: string | undefined;
  duration?: number | undefined;
  thumbnail?: string | undefined;
}

export function mediaFrom(fetch: Fetch) {
  const json = async (hosts: RegExp, url: string): Promise<unknown> =>
    JSON.parse((await fetchFrom(fetch, hosts, url, PAGE_BYTES)).bytes.toString("utf8"));

  async function youtube(url: URL): Promise<Meta> {
    const o = OEmbed.parse(await json(YOUTUBE, `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.href)}`));
    // oEmbed has no duration; the watch page embeds it
    const secure = new URL(url);
    secure.protocol = "https:";
    const page = await fetchFrom(fetch, YOUTUBE, secure.href, PAGE_BYTES).then((r) => r.bytes.toString("utf8"), () => "");
    const duration = Number(/"lengthSeconds":"(\d+)"/.exec(page)?.[1]) || undefined;
    return { source: "youtube", title: o.title, creator: o.author_name, thumbnail: o.thumbnail_url, duration };
  }

  async function patreon(url: URL): Promise<Meta> {
    const id = /posts\/(?:.*-)?(\d+)\/?$/.exec(url.pathname)?.[1];
    if (!id) throw new MediaError("No post id in Patreon URL");
    const post = PatreonPost.parse(await json(PATREON, `https://www.patreon.com/api/posts/${id}?include=campaign,media`));
    const a = post.data.attributes;
    const of = (type: string) => (post.included ?? []).filter((i) => i.type === type).map((i) => i.attributes ?? {});
    const campaign = of("campaign")[0] ?? {};
    const user = of("user")[0] ?? {};
    const image = attributes.catch({}).parse(a["image"]);
    const thumb = attributes.catch({}).parse(a["thumbnail"]);
    // only present when the post is viewable logged out; paywalled posts leave it to the user
    const seconds = of("media").map((m) => {
      const d = attributes.catch({}).parse(m["display"]);
      return Number(d["full_content_duration"] ?? d["duration"]) || 0;
    });
    return {
      source: "patreon",
      title: text(a["title"]),
      creator: text(campaign["name"]) ?? text(user["full_name"]),
      duration: Math.round(Math.max(0, ...seconds)) || undefined,
      // locked/poll posts often have no image; fall back to the creator's avatar
      thumbnail:
        text(image["large_url"]) ?? text(image["url"]) ?? text(thumb["url"]) ?? text(campaign["avatar_photo_url"]) ?? text(user["image_url"]),
    };
  }

  async function meta(link: string): Promise<Meta> {
    const url = new URL(link);
    if (YOUTUBE.test(url.hostname)) return youtube(url);
    if (PATREON.test(url.hostname)) return patreon(url);
    return { source: "other" }; // the page asks for title + thumbnail
  }

  async function image(url: string) {
    const r = await fetchFrom(fetch, PATREON_IMAGES, url, IMAGE_BYTES);
    if (!/^image\/(png|jpeg|gif|webp|avif)\b/.test(r.type)) throw new MediaError("Not an image");
    return r.bytes;
  }

  /** Patreon's image URLs expire after a few weeks; a dead one is replaced by asking for the post again. */
  async function patreonThumb(post: string, saved: string) {
    try {
      return await image(saved);
    } catch {
      const url = new URL(post);
      const fresh = PATREON.test(url.hostname) ? (await patreon(url)).thumbnail : undefined;
      if (!fresh) throw new MediaError("No thumbnail");
      return image(fresh);
    }
  }

  return { meta, patreonThumb };
}
