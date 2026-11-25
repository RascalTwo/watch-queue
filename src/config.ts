import { z } from "@hono/zod-openapi";

const parsed = z
  .object({
    DB_PATH: z.string().min(1),
    BASE_URL: z.url().default("http://localhost:4747"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().default(4747),
    GIT_SHA: z.string().default("dev"),
  })
  .safeParse(process.env);

if (!parsed.success) {
  console.error(`Bad configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  process.exit(1);
}
export const config = parsed.data;
