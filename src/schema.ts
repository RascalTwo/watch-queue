import { z } from "@hono/zod-openapi";

export const MAX_ITEMS = 500;

const webUrl = z
  .string()
  .max(4000)
  .refine((s) => URL.canParse(s) && /^https?:$/.test(new URL(s).protocol), "must be an http(s) link");

const thumbnail = z
  .string()
  .max(100_000)
  .refine(
    (s) => s === "" || /^data:image\/(png|jpeg|gif|webp|avif);base64,/.test(s) || webUrl.safeParse(s).success,
    "must be an http(s) or data:image link",
  );

export const Item = z.object({
  id: z.uuid(),
  url: webUrl,
  source: z.enum(["youtube", "patreon", "other"]),
  title: z.string().max(500),
  creator: z.string().max(200).optional(),
  duration: z.number().nonnegative().max(10_000_000).optional(),
  thumbnail: thumbnail.optional(),
  tags: z.array(z.string().max(100)).max(50),
});
export type Item = z.infer<typeof Item>;

export const Content = z
  .object({ items: z.array(Item), pile: z.array(Item), rules: z.string().max(50_000) })
  .refine((c) => c.items.length + c.pile.length <= MAX_ITEMS, `a list holds at most ${MAX_ITEMS} items`)
  .refine((c) => {
    const ids = [...c.items, ...c.pile].map((i) => i.id);
    return new Set(ids).size === ids.length;
  }, "item ids must be unique");
export type Content = z.infer<typeof Content>;

/** 32 random bytes, base64url. The browser makes list secrets; the server makes invite codes. */
export const Secret = z.string().regex(/^[\w-]{43}$/, "must be 32 bytes, base64url");
