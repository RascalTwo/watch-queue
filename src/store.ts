import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Content } from "./schema.ts";

// Secrets carry 256 random bits, so a plain hash is enough (there is nothing to guess).
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
export const newSecret = () => randomBytes(32).toString("base64url");

export interface List {
  id: string;
  name: string;
  version: number;
  disabled: boolean;
  content: Content;
}

export type Redeemed = "ok" | "invalid" | "used";

const EMPTY: Content = { items: [], pile: [], rules: "" };

export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        disabled INTEGER NOT NULL DEFAULT 0,
        last_used TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE TABLE IF NOT EXISTS invites (
        code_hash TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        list_id TEXT REFERENCES lists(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS thumbs (
        list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        src TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (list_id, item_id)
      ) STRICT;
    `);
  }

  close() {
    this.#db.close();
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  createInvite(name: string): string {
    const code = newSecret();
    this.#db.prepare("INSERT INTO invites (code_hash, name) VALUES (?, ?)").run(hash(code), name);
    return code;
  }

  /** Repeating a redeem with the same secret succeeds, so a lost response can't burn an invite. */
  redeem(code: string, secret: string): Redeemed {
    return this.#transaction(() => {
      const invite = this.#db.prepare("SELECT name, list_id FROM invites WHERE code_hash = ?").get(hash(code));
      if (!invite) return "invalid";
      const owner = this.#db.prepare("SELECT id FROM lists WHERE secret_hash = ?").get(hash(secret));
      if (invite["list_id"] !== null) return owner?.["id"] === invite["list_id"] ? "ok" : "used";
      if (owner) return "invalid";
      const id = this.createList(String(invite["name"]), secret, EMPTY);
      this.#db.prepare("UPDATE invites SET list_id = ? WHERE code_hash = ?").run(id, hash(code));
      return "ok";
    });
  }

  createList(name: string, secret: string, content: Content): string {
    const id = randomUUID();
    this.#db
      .prepare("INSERT INTO lists (id, secret_hash, name, content) VALUES (?, ?, ?, ?)")
      .run(id, hash(secret), name, JSON.stringify(content));
    return id;
  }

  open(secret: string): List | undefined {
    const row = this.#db
      .prepare("UPDATE lists SET last_used = CURRENT_TIMESTAMP WHERE secret_hash = ? RETURNING *")
      .get(hash(secret));
    return (
      row && {
        id: String(row["id"]),
        name: String(row["name"]),
        version: Number(row["version"]),
        disabled: row["disabled"] === 1,
        content: Content.parse(JSON.parse(String(row["content"]))),
      }
    );
  }

  /** Saves only over the version the caller last saw; otherwise changes nothing and returns undefined. */
  save(listId: string, seen: number, content: Content): number | undefined {
    return this.#transaction(() => {
      const row = this.#db
        .prepare("UPDATE lists SET content = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING version")
        .get(JSON.stringify(content), listId, seen);
      if (!row) return undefined;
      const kept = JSON.stringify([...content.items, ...content.pile].map((i) => i.id));
      this.#db
        .prepare("DELETE FROM thumbs WHERE list_id = ? AND item_id NOT IN (SELECT value FROM json_each(?))")
        .run(listId, kept);
      return Number(row["version"]);
    });
  }

  replaceSecret(listId: string, secret: string) {
    this.#db.prepare("UPDATE lists SET secret_hash = ? WHERE id = ?").run(hash(secret), listId);
  }

  thumb(listId: string, itemId: string, src: string): Uint8Array<ArrayBuffer> | undefined {
    const row = this.#db
      .prepare("SELECT bytes FROM thumbs WHERE list_id = ? AND item_id = ? AND src = ?")
      .get(listId, itemId, src);
    return row?.["bytes"] as Uint8Array<ArrayBuffer> | undefined;
  }

  /** Skips an item that was removed while its image was downloading, so no orphan is left behind. */
  saveThumb(listId: string, itemId: string, src: string, bytes: Uint8Array) {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO thumbs (list_id, item_id, src, bytes)
         SELECT l.id, ?, ?, ? FROM lists l WHERE l.id = ? AND EXISTS (
           SELECT 1 FROM json_each(l.content, '$.items') WHERE value ->> 'id' = ?
           UNION SELECT 1 FROM json_each(l.content, '$.pile') WHERE value ->> 'id' = ?)`,
      )
      .run(itemId, src, bytes, listId, itemId, itemId);
  }

  lists() {
    return this.#db
      .prepare(
        `SELECT id, name, disabled, last_used,
           json_array_length(content, '$.items') + json_array_length(content, '$.pile') AS items,
           (SELECT count(*) FROM thumbs t WHERE t.list_id = lists.id) AS thumbs,
           (SELECT coalesce(sum(length(bytes)), 0) FROM thumbs t WHERE t.list_id = lists.id) AS thumb_bytes
         FROM lists ORDER BY name`,
      )
      .all()
      .map((r) => ({ ...r }));
  }

  openInvites() {
    return this.#db
      .prepare("SELECT name, created FROM invites WHERE list_id IS NULL ORDER BY created")
      .all()
      .map((r) => ({ ...r }));
  }

  setDisabled(listId: string, disabled: boolean): boolean {
    return this.#db.prepare("UPDATE lists SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, listId).changes === 1;
  }

  has(listId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM lists WHERE id = ?").get(listId) !== undefined;
  }
}
