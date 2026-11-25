# Watch Queue

Read [README.md](README.md) and the decisions in `docs/adr/` first (kept out of the public copy). `npm run check` must pass.

## Terms

- **list**: one person's queue, pile and tag rules, saved and versioned together.
- **pile**: items added but not yet given a spot in the queue.
- **secret link**: `/#list=<secret>`; whoever has it has the list. The server stores only a hash of the secret.
- **invite**: `/#invite=<code>`, a one-time link that makes a list.
