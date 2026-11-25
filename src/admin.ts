import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { Content } from "./schema.ts";
import { newSecret, Store } from "./store.ts";

const USAGE = `npm run admin -- <command>
  invite <name>           make a one-time invite link
  lists                   show every list and unused invite
  off <list id>           switch a list off
  on <list id>            switch it back on
  relink <list id>        make a new link for someone who lost theirs (the old one stops working)
  import <folder> <name>  make a list from the old app's data.json, pile.json and tag-rules.txt`;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const listLink = (secret: string) => `${config.BASE_URL}/#list=${secret}`;

const [command, first, second] = process.argv.slice(2);
const store = new Store(config.DB_PATH);

const need = (value: string | undefined): string => value?.trim() || fail(USAGE);
const needList = (): string => {
  const id = need(first);
  return store.has(id) ? id : fail(`No list ${id}`);
};

switch (command) {
  case "invite":
    console.log(`${config.BASE_URL}/#invite=${store.createInvite(need(first))}`);
    break;
  case "lists":
    console.table(store.lists());
    console.log("Unused invites:");
    console.table(store.openInvites());
    break;
  case "off":
  case "on":
    store.setDisabled(needList(), command === "off");
    break;
  case "relink": {
    const id = needList();
    const secret = newSecret();
    store.replaceSecret(id, secret);
    console.log(listLink(secret));
    break;
  }
  case "import": {
    const folder = need(first);
    const name = need(second);
    const read = (file: string) => readFileSync(join(folder, file), "utf8");
    const content = Content.safeParse({
      items: JSON.parse(read("data.json")),
      pile: existsSync(join(folder, "pile.json")) ? JSON.parse(read("pile.json")) : [],
      rules: existsSync(join(folder, "tag-rules.txt")) ? read("tag-rules.txt") : "",
    });
    if (!content.success) fail(`Can't import: ${content.error.message}`);
    else {
      const secret = newSecret();
      store.createList(name, secret, content.data);
      console.log(`${content.data.items.length} items imported\n${listLink(secret)}`);
    }
    break;
  }
  default:
    fail(USAGE);
}
store.close();
