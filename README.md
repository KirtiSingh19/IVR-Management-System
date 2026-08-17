# IVR Manager — Stage 1

A frontend prototype for administering IVRs: create them, give them extensions, build the menu
callers hear, manage the audio prompts, and walk a simulated call through the result.

**Stage 1 is frontend only.** There is no backend, database, REST API, Asterisk connection, SIP
integration or authentication. Records are saved in the browser's own storage. Every screen is
built so that Stage 2 can attach a real API without the UI being rewritten.

---

## Running it

You need Docker. Nothing else — no Node, no Python, no build step.

```bash
cd ivr-manager

docker compose build      # build the image
docker compose up -d      # start it
docker compose ps         # check it is running and healthy
docker compose logs -f    # follow the access log (Ctrl+C to stop following)
docker compose down       # stop and remove the container
```

Then open **<http://localhost:8080>**.

Port 8080 is already taken? Change the left-hand number in `docker-compose.yml`:

```yaml
ports:
  - "9090:80"
```

`docker compose down` removes the container but not your data — that lives in your browser, and
survives until you clear site data or use **Reset demo data** in the user menu.

### Picking up code changes

The image contains a copy of the files, so editing a file on disk does not change what the
container serves. Rebuild:

```bash
docker compose up -d --build
```

---

## What is in the box

| Page | What it does |
|---|---|
| **Dashboard** | Totals for IVRs and audio, active/inactive split, recent activity, quick actions |
| **IVR List** | Search, status filter, extension-range filter, sortable columns, pagination, view/edit/test/delete |
| **Create IVR** | Validated form; on success it takes you to the edit screen to build the menu |
| **Edit IVR** | The same form prefilled from `?id=`, plus the flow builder and deletion |
| **Audio Files** | Upload by click or drag-and-drop, search, format filter, play/stop, delete |
| **Test IVR** | Call simulator with a working DTMF keypad, live call log, and a dialplan tree |

### Two things worth trying

**The keypad is real.** On the Test IVR page, press keys with your mouse *or your keyboard*. Each
key sounds the actual DTMF dual-tone pair a telephone would send — 697 Hz and 1209 Hz for `1`, and
so on. Pressing a key on an idle line dials first, exactly like picking up a handset.

**The simulator reads your own menu.** Whatever you build in the flow builder is what the simulator
offers. Add an option on the edit screen, switch to Test IVR, and it is there. Press a key with no
option behind it and you get the invalid-option prompt, as a real IVR would answer.

---

## Project layout

```
ivr-manager/
├── index.html              entry point; forwards to pages/dashboard.html
│
├── pages/                  one real HTML document per screen
│   ├── dashboard.html      create-ivr.html    audio-files.html
│   ├── ivr-list.html       edit-ivr.html      test-ivr.html
│
├── components/             shared chrome, injected at runtime by app.js
│   ├── sidebar.html  navbar.html  footer.html  modals.html
│
├── css/
│   ├── style.css           design tokens, application shell, every Bootstrap override
│   ├── dashboard.css       stat tiles, status overview, quick actions
│   ├── ivr.css             flow builder, dialplan tree, keypad, simulator
│   ├── audio.css           dropzone, file cells, playback bar
│   └── responsive.css      every breakpoint rule in the project, loaded last
│
├── js/
│   ├── app.js              entry point on every page: shell, nav, boot
│   ├── ui.js               toasts, confirmation dialog, pagination, table placeholders
│   ├── storage.js          the only module that touches localStorage
│   ├── repo.js             IvrRepo / AudioRepo / FlowRepo  ← the Stage 2 seam
│   ├── utils.js            escaping, formatting, validation rules
│   ├── dashboard.js  ivr.js  audio.js  flow-builder.js  test-ivr.js
│
├── data/demo-data.js       seed records, written to storage on first run
│
├── assets/
│   ├── audio/              generated demo prompts (real WAV files)
│   ├── icons/              favicon
│   └── vendor/             Bootstrap, Bootstrap Icons, IBM Plex, compiled Tailwind
│
├── tools/                  authoring-time only; never shipped, never in the image
├── nginx/default.conf
├── Dockerfile  docker-compose.yml  .dockerignore  .gitignore
└── README.md
```

Three modules are not in the original outline, and each earns its place:

- **`js/repo.js`** — the repositories. Keeping them out of `storage.js` means Stage 2 replaces one
  file's internals rather than untangling data access from persistence.
- **`js/ui.js`** — toasts, the confirmation dialog and table helpers. Keeping them out of `app.js`
  means page controllers can use them without importing the shell that loads them.
- **`js/flow-builder.js`** — the menu builder is a self-contained feature mounted into the edit
  page, not part of the IVR form.

---

## How it is put together

### Layers

```
data/demo-data.js
        │ seeds once, on first run
        ▼
js/storage.js     namespaced keys, safe reads, quota handling, change events
        ▼
js/repo.js        IvrRepo / AudioRepo / FlowRepo
        ▼
page controllers  dashboard.js  ivr.js  audio.js  flow-builder.js  test-ivr.js
        ▼
js/app.js         shell: component injection, active nav, global actions
```

The UI never touches `localStorage`. That one rule is what makes Stage 2 a small change.

### The Stage 2 seam

Every repository method is `async` and named for the REST verb it will become, and filters,
sorting and pagination are passed in as a query object rather than applied by the view:

```js
// Stage 1
async list(query) { return paginate(filter(store.read(KEYS.IVRS), query), query); }

// Stage 2 — identical signature, every caller unchanged
async list(query) { return (await fetch(`/api/ivrs?${qs(query)}`)).json(); }
```

Because the reads are already asynchronous, loading and error states are real code paths today
rather than decoration. No artificial delays are used anywhere to fake them.

### Bootstrap and Tailwind

They are kept apart by one rule:

- **Bootstrap owns components** — modals, dropdowns, toasts, offcanvas, tables, forms, buttons,
  pagination. Anything with behaviour.
- **Tailwind owns layout and spacing only**, and every utility is prefixed `tw-`.

The prefix is not cosmetic: `border`, `flex` and `hidden` exist in both frameworks, and without it
the winner would depend on stylesheet order. The Tailwind build also has Preflight disabled,
because Preflight is a CSS reset and Bootstrap already ships one — loading both means the second
silently undoes the first.

### Regenerating the generated files

Both outputs are committed, so the container needs no build step. Regenerate them on a developer
machine only if you change the inputs:

```bash
# Tailwind — after adding tw- classes that were not previously used anywhere
npx -y tailwindcss@3.4.17 -c tools/tailwind.config.js -i tools/tailwind-input.css \
  -o assets/vendor/tailwind.css --minify

# Demo audio prompts
node tools/make-demo-audio.mjs
```

Tailwind only emits utilities it can find in the files listed under `content` in
`tools/tailwind.config.js`. A `tw-` class used for the first time will have no effect until this
is re-run.

If you regenerate the audio at a different length or sample rate, update the `sizeBytes` and
`durationSeconds` values in `data/demo-data.js` so the table shows the truth.

---

## Testing checklist

Work through this against a fresh browser profile, or after **Reset demo data**.

### Seeding and persistence
- [ ] First load shows 3 IVRs (Main 5000, Sales 5001, Support 5002) and 3 audio files
- [ ] Dashboard reads Total 3, Active 2, Inactive 1, Audio Files 3
- [ ] Create an IVR, reload the page — it is still there
- [ ] Delete every IVR, reload — the list stays empty and shows the empty state (demo data is not
      pushed back at you)
- [ ] **Reset demo data** in the user menu restores the original 3 IVRs

### Create
- [ ] Submitting the empty form shows errors and focuses the first bad field
- [ ] A 2-character name is rejected; a 3-character name is accepted
- [ ] Extension `12` and `abcd` are rejected; `5100` is accepted
- [ ] Reusing extension `5000` is rejected with a message naming the IVR that has it
- [ ] A successful create shows a toast and lands you on the edit screen
- [ ] The dashboard totals have gone up

### Edit
- [ ] `edit-ivr.html?id=ivr-main` opens with the form filled in
- [ ] An unknown id shows the "could not be found" panel, not a broken page
- [ ] Changing the name updates the breadcrumb and the page title after saving
- [ ] Changing an extension to one already in use is rejected
- [ ] Switching status to Inactive is reflected on the dashboard and in the list badge

### Delete
- [ ] Delete asks for confirmation and names the IVR and how many menu options go with it
- [ ] Cancel, Escape and clicking the backdrop all leave the record alone
- [ ] Confirming removes the row, updates the dashboard, and shows a toast
- [ ] Deleting an IVR that had menu options leaves no orphan menu behind (re-create an IVR and
      check its menu starts empty)

### List
- [ ] Search matches name, extension and description, and is case-insensitive
- [ ] Status filter and extension-range filter combine with the search
- [ ] "No IVRs match those filters" appears with a Clear filters button that works
- [ ] Clicking a column header sorts, and clicking again reverses it
- [ ] With more than 10 IVRs, pagination appears and the "Showing x–y of z" line is right
- [ ] Changing a filter returns to page 1
- [ ] The global search box in the top bar lands on the list with the term applied

### Audio
- [ ] Play sounds a tone; the row highlights and the playback bar appears
- [ ] Playing a second file stops the first — never two at once
- [ ] Pause and resume work; Stop clears the bar and the highlight
- [ ] Clicking the progress track seeks
- [ ] Uploading a file adds a row with its real duration and size
- [ ] Uploading a file whose name already exists is rejected with a message
- [ ] Drag-and-drop onto the dropzone works, and the zone highlights while dragging
- [ ] After a reload, an uploaded row is still listed, marked "Audio not kept after reload", and
      its Play button is disabled
- [ ] Deleting a file that is playing stops playback

### Flow builder
- [ ] Add an option: digit, label and destination all validate
- [ ] Digits already used are greyed out in the picker
- [ ] Editing an option keeps its own digit selectable
- [ ] Deleting an option warns that callers will hear the invalid-option prompt instead

### Test IVR
- [ ] The selector lists every IVR; `test-ivr.html?id=ivr-main` preselects one
- [ ] Call plays the welcome prompt, then reads the menu out
- [ ] Pressing `1` shows the selected label and destination extension, and highlights the branch
      in the dialplan tree
- [ ] Pressing a digit with no option gives the invalid-option prompt and keeps the call up
- [ ] Keyboard digits work; typing in the search box does *not* trigger the keypad
- [ ] Each key press makes a sound (two tones, not one)
- [ ] Main menu returns to the menu; Hang up ends the call and disables the transport buttons
- [ ] Every step appears in the call log with a timestamp
- [ ] An IVR with no options shows "This IVR has no menu yet" instead of an empty tree

### Responsive and accessibility
- [ ] At 1440 px the sidebar is fixed; below 992 px it becomes a drawer with a working toggle
- [ ] Tables scroll sideways on a phone rather than squashing
- [ ] Tab reaches every control; focus is always visible
- [ ] The skip link appears on the first Tab press and jumps to the main content
- [ ] Escape closes modals and returns focus to the button that opened them
- [ ] With `prefers-reduced-motion: reduce` set, nothing animates

### Docker
- [ ] `docker compose ps` reports `healthy` after roughly ten seconds
- [ ] All six pages load with no 404s in the network panel
- [ ] The browser console is clean on every page
- [ ] Disconnecting from the internet changes nothing — every dependency is vendored

---

## Stage 2

The shape this is built towards:

```
Browser
   │
   ▼
IVR Manager frontend  ── nginx also proxies /api/ ──┐
                                                     ▼
                                            Django / FastAPI
                                                 │      │
                                        PostgreSQL      Asterisk ── SIP
                                                                 └─ dialplan
```

What changes:

1. `js/repo.js` — method bodies swap `storage` calls for `fetch`. Signatures stay.
2. `nginx/default.conf` — add a `location /api/` block with a `proxy_pass`.
3. `docker-compose.yml` — add the API, database and Asterisk services.
4. `data/demo-data.js` and `js/storage.js` — delete.
5. Authentication — the user menu in `components/navbar.html` gains real sign-in.

What does not change: the pages, the CSS, and every controller in `js/`.
