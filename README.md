# Watch Queue

One ordered list of everything you want to watch, from YouTube, Patreon or anywhere else. Invite only: a one-time invite makes a list, and the list's secret link is its login.

## Run

```sh
npm ci
DB_PATH=watch-queue.db npm start
DB_PATH=watch-queue.db npm run admin -- invite Sam   # prints an invite link to send
npm run check                                        # types and tests
```

`npm run admin` with no command lists the rest: see every list, switch one off, replace a lost link, import the old single-user app's files.

`BASE_URL` is the address the admin commands print links for (default `http://localhost:4747`). `HOST`, `PORT` and `GIT_SHA` are optional. Everything is stored in the SQLite file at `DB_PATH`, so back that up.

The API is described by its routes in [src/app.ts](src/app.ts).
