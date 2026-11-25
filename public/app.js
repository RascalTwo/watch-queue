let items = [];
let pile = [];        // added but not yet given a spot in the queue
let ordering = false; // ordering mode: keep handing out pile[0] to place
let pending = null;   // the pile item currently being placed (pile[0] while ordering)
let drafts = [];      // links waiting for manual details, one at a time
let autoOrder = false; // a single link was added: go straight to placing it
let filter = { source: null, creator: null, tag: null }; // each: one active value or null
let dragId = null;
let editing = null;   // id of the item whose edit form is open
let rules = '';       // tag-rules text, see the Tag rules panel

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parseRules = text => text.split('\n')
  .map(l => l.match(/^\s*([^#\s][^=]*?)\s*=\s*(.+)$/)).filter(Boolean)
  .map(([, tag, phrases]) => ({ tag, res: phrases.split(',').map(p => p.trim()).filter(Boolean)
    // whole-word match; ALL-CAPS phrases (abbreviations) are case-sensitive
    // word-boundary only at edges that are word chars, so "example.com/tv/" can be followed by anything
    .map(p => new RegExp(`${/^\w/.test(p) ? '(?<!\\w)' : ''}${escRe(p)}${/\w$/.test(p) ? '(?!\\w)' : ''}`, /[A-Z]/.test(p) && p === p.toUpperCase() ? '' : 'i')) }));
// URL punctuation becomes spaces so "space show" matches a /space-show-s3 slug
const urlWords = url => { try { url = decodeURIComponent(url); } catch {} return url.replace(/[-_+/.?=&#:]+/g, ' '); };
const tagsFor = (text, it) => parseRules(text).filter(r => r.res.some(re => re.test(`${it.title} ${it.creator ?? ''} ${it.url ?? ''} ${urlWords(it.url ?? '')}`))).map(r => r.tag);
const autoTags = it => tagsFor(rules, it);
{
  const r = 'Space Show = space show, SP\n# comment = x\nGarden Show = garden show, ASH';
  console.assert(String(tagsFor(r, { title: 'SP - 3x04 - Reaction' })) === 'Space Show', 'abbrev');
  console.assert(String(tagsFor(r, { title: 'Space Show s3 ep3' })) === 'Space Show', 'phrase any case');
  console.assert(String(tagsFor(r, { title: 'ASH - 1x09', creator: 'Fan' })) === 'Garden Show', 'ash caps');
  console.assert(String(tagsFor(r, { title: 'Ash from the fire, SPX special' })) === '', 'lowercase ash / SPX do not match');
  console.assert(String(tagsFor(r, { title: 'Ep 3', url: 'https://www.patreon.com/posts/space-show-s3-123' })) === 'Space Show', 'url slug');
  const u = 'Show = example.com/tv/\nMovie = example.com/movie/';
  console.assert(String(tagsFor(u, { title: 'Show S4E6', url: 'https://example.com/tv/show/124364' })) === 'Show', 'raw url fragment');
  console.assert(String(tagsFor(u, { title: 'x', url: 'https://example.com/movie/x/1' })) === 'Movie', 'raw url fragment 2');
}
// "1:02:30" | "12:30" | "45" (minutes) -> seconds
const parseDur = s => s.includes(':') ? s.split(':').reduce((t, p) => t * 60 + +p, 0) : +s * 60;
const fmtDur = sec => { const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
console.assert(parseDur('1:02:30') === 3750 && parseDur('12:30') === 750 && parseDur('45') === 2700 && fmtDur(3750) === '1:02:30' && fmtDur(750) === '12:30', 'duration helpers');

const $ = s => document.querySelector(s);
// Patreon's own URLs expire, so the server keeps a copy. It needs the list's secret, which an <img> can't send, so the page fetches it.
const isSigned = u => { try { return /(^|\.)patreonusercontent\.com$|^image\.mux\.com$/.test(new URL(u).hostname); } catch { return false; } };
const thumbKey = it => it.id + ' ' + it.thumbnail;
const blobs = new Map(); // thumbKey -> object URL, or '' while loading
const thumbAttrs = it => {
  if (it.source === 'patreon' && isSigned(it.thumbnail)) return blobs.get(thumbKey(it)) ? `src="${blobs.get(thumbKey(it))}"` : `data-thumb="${it.id}"`;
  // YouTube's hqdefault is 4:3 with black bars baked in; mqdefault is the same picture at 16:9 and exists for every video
  return `src="${esc(it.source === 'youtube' ? it.thumbnail?.replace('/hqdefault.jpg', '/mqdefault.jpg') : it.thumbnail)}"`;
};
// Poster-shaped (or any off-16:9) images sit on a blurred, darkened copy of themselves instead of black bars
const thumbImg = (it, cls = '', lazy = '') => `<span class="fit${cls ? ' ' + cls : ''}"><img class="blur" ${thumbAttrs(it)} alt="" aria-hidden="true"${lazy}><img ${thumbAttrs(it)} alt=""${lazy}></span>`;
async function loadThumb(it) {
  const key = thumbKey(it);
  if (blobs.has(key)) return;
  blobs.set(key, '');
  await saving; // the server must know an item before its thumbnail is requested
  const r = await api(`/api/thumb/${it.id}?${encodeURIComponent(it.thumbnail.slice(-40))}`).catch(() => null); // the query only busts the browser cache
  if (!r?.ok) return blobs.delete(key);
  blobs.set(key, URL.createObjectURL(await r.blob()));
  for (const img of document.querySelectorAll(`img[data-thumb="${it.id}"]`)) img.src = blobs.get(key);
}
const seen = new IntersectionObserver(entries => {
  for (const { isIntersecting, target } of entries) {
    const it = isIntersecting && [...items, ...pile].find(i => i.id === target.dataset.thumb);
    if (it) { seen.unobserve(target); loadThumb(it); }
  }
}, { rootMargin: '300px' });
// a bad link (from an import, say) must never become a clickable script
const href = it => esc(/^https?:/i.test(it.url) ? it.url : '#');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const srcOf = it => ({ youtube: 'YouTube', patreon: 'Patreon' })[it.source] || (URL.canParse(it.url) ? new URL(it.url).hostname.replace(/^www\./, '') : it.url);
// same video under different links (youtu.be, &t=, shorts, Patreon slugs) -> same key
const keyOf = url => {
  try {
    const u = new URL(url), h = u.hostname.replace(/^(www|m)\./, '');
    const yt = h === 'youtu.be' ? u.pathname.slice(1) : /youtube\.com$/.test(h) && (u.searchParams.get('v') || u.pathname.match(/\/(?:shorts|live|embed)\/([^/]+)/)?.[1]);
    if (yt) return 'yt:' + yt;
    const pt = h.endsWith('patreon.com') && u.pathname.match(/posts\/(?:.*-)?(\d+)\/?$/)?.[1];
    if (pt) return 'pt:' + pt;
    return h + u.pathname.replace(/\/$/, '') + u.search;
  } catch { return url; }
};
console.assert(keyOf('https://youtu.be/abc?t=3') === keyOf('https://www.youtube.com/watch?v=abc&list=x') && keyOf('https://youtube.com/shorts/abc') === 'yt:abc', 'yt keys');
console.assert(keyOf('https://www.patreon.com/x/posts/foo-123') === keyOf('https://patreon.com/posts/123/') && keyOf('https://a.com/p/') === keyOf('https://www.a.com/p#x'), 'other keys');

const LOGOS = { YouTube: 'https://www.youtube.com/favicon.ico', Patreon: 'https://www.patreon.com/favicon.ico' };
const srcBadge = label => LOGOS[label] ? `<img class="logo" src="${LOGOS[label]}" alt="${label}">` : esc(label);
const facets = { source: it => [srcOf(it)], creator: it => it.creator ? [it.creator] : [], tag: it => it.tags };
const values = key => [...new Set(items.flatMap(facets[key]))].sort((a, b) => a.localeCompare(b));
const allTags = () => values('tag');
// "Time I have": blank or unparseable means no limit; items with unknown length are hidden while a limit is set
const maxDur = () => { const v = $('#maxdur').value.trim(); return /^\d+(:[0-5]?\d){0,2}$/.test(v) ? parseDur(v) : null; };
const fitsTime = it => maxDur() == null || (it.duration > 0 && it.duration <= maxDur());
const matches = it => fitsTime(it) && Object.entries(filter).every(([k, v]) => !v || facets[k](it).includes(v));
const say = (text, err) => { $('#msg').textContent = text; $('#msg').className = err ? 'err' : ''; };

let secret = null;  // this list's secret: whoever has it has the list
let version = 0;    // the version of the list this page last saw
let dirty = false;
let saving = Promise.resolve();
const api = (path, { method = 'GET', body } = {}) => fetch(path, { method, body: body && JSON.stringify(body), headers: { Authorization: 'Bearer ' + secret, ...(body && { 'Content-Type': 'application/json' }) } });
const problem = async r => (await r.json().catch(() => ({}))).error ?? `error ${r.status}`;

function adopt(list) {
  ({ items, pile, version } = list);
  rules = $('#rules').value = list.rules;
  ordering = false; pending = null; editing = null;
  render();
}

// saves run one at a time, each sending the newest list
function save() {
  dirty = true;
  return saving = saving.then(async () => {
    if (!dirty) return true;
    dirty = false;
    try {
      const r = await api('/api/list', { method: 'PUT', body: { version, content: { items, pile, rules } } });
      if (r.ok) { version = (await r.json()).version; return true; }
      if (r.status === 409) { adopt(await r.json()); say('Your list was changed on another device or tab, so your last change was not saved. This is the latest list.', true); return false; }
      throw new Error(await problem(r));
    } catch (e) {
      dirty = true;
      say('Save failed: ' + e.message, true);
      return false;
    }
  });
}
const savePile = save; // the queue and the pile are saved together

// coming back to this tab: pick up changes made elsewhere
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !secret) return;
  saving = saving.then(async () => {
    const r = await api('/api/list').catch(() => null);
    if (!r?.ok || dirty || editing || pending || drafts.length) return;
    const list = await r.json();
    if (!dirty && !editing && !pending && list.version !== version) adopt(list);
  });
});

// pull URLs out of pasted text, even when newlines got lost between them
const extractUrls = text => text.match(/https?:\/\/.+?(?=https?:\/\/|\s|$)/g) ?? [];
console.assert(extractUrls('https://a.com/1 https://b.com/2\nhttps://c.com/3https://d.com/4').length === 4, 'extractUrls');

// hand the next pile item to the placing bar, or leave ordering mode when the pile is empty
function next() {
  if (ordering && pile.length && !items.length) { items.push(pile.shift()); save(); savePile(); } // nothing to place relative to
  if (!pile.length) ordering = false;
  pending = ordering ? pile[0] : null;
  render();
}

function card(it, n) {
  return `<li class="item" data-id="${it.id}" draggable="true">
    <span class="handle" title="Drag to reorder">⠿</span><span class="num">${n}</span>
    <a class="thumbwrap" href="${href(it)}" target="_blank" rel="noopener">${thumbImg(it, 'thumb', ' loading="lazy"')}${it.duration ? `<span class="dur">${fmtDur(it.duration)}</span>` : ''}</a>
    <div class="body">${editing === it.id ? editForm(it) : `
      <a class="title" href="${href(it)}" target="_blank" rel="noopener">${esc(it.title || it.url)}</a>
      <div class="meta">
        <button class="src src-${it.source}" data-facet="source" data-value="${esc(srcOf(it))}" title="Show only ${esc(srcOf(it))}">${srcBadge(srcOf(it))}</button>
        ${it.creator ? `<button data-facet="creator" data-value="${esc(it.creator)}" title="Show only ${esc(it.creator)}">${esc(it.creator)}</button>` : '<span></span>'}
      </div>
      <div class="tags">
        ${it.tags.map(t => `<span class="chip" data-facet="tag" data-value="${esc(t)}">${esc(t)}<span class="x" data-untag="${esc(t)}" title="Remove tag">×</span></span>`).join('')}
        <input list="alltags" placeholder="+ tag" data-addtag aria-label="Add tag">
      </div>`}
    </div>
    <div class="actions"><button data-edit title="Edit">✎</button><button data-del title="Remove (watched)">✕</button></div>
  </li>`;
}

function editForm(it) {
  const row = (name, label, value, extra = '') => `<label for="e-${name}">${label}</label><input id="e-${name}" name="${name}" value="${esc(value)}" ${extra}>`;
  return `<form class="editform">
    ${row('title', 'Title', it.title, 'required')}
    ${row('creator', 'Creator', it.creator)}
    ${row('url', 'Link', it.url, 'type="url" required')}
    ${row('thumbnail', 'Thumbnail', it.thumbnail, 'type="url"')}
    ${row('duration', 'Duration', it.duration ? fmtDur(it.duration) : '', 'placeholder="1:02:30 or 45" pattern="\\d+(:[0-5]\\d){0,2}"')}
    <div><button>Save</button><button type="button" data-editcancel>Cancel</button></div>
  </form>`;
}

function render() {
  $('#alltags').innerHTML = allTags().map(t => `<option value="${esc(t)}">`).join('');
  $('#filters').innerHTML = [['source', 'Source'], ['creator', 'Creator'], ['tag', 'Tag']].map(([k, label]) => values(k).length ? `<span class="label">${label}</span><div class="row">${values(k).map(v => `<button class="chip ${v === filter[k] ? 'on' : ''}" data-facet="${k}" data-value="${esc(v)}" title="${esc(v)}">${k === 'source' ? srcBadge(v) : esc(v)}</button>`).join('')}</div>` : '').join('');
  // the item being placed floats over the page so the list doesn't move
  document.body.classList.toggle('placing', !!pending);
  $('#placing').hidden = !pending;
  if (pending) $('#placing').innerHTML = `<a class="thumbwrap" href="${href(pending)}" target="_blank" rel="noopener" title="Open it">${thumbImg(pending)}</a>
    <div class="what"><a class="title" href="${href(pending)}" target="_blank" rel="noopener" title="Open it">${esc(pending.title)}</a><span class="hint">${pile.length > 1 ? `${pile.length} left to place. ` : ''}Click the top or bottom half of an item to put it above or below.${pending.tags.length ? ' Tags: ' + pending.tags.map(esc).join(', ') : ''}</span></div>
    ${pile.length > 1 ? '<button data-skip title="Place this one later">Later</button>' : ''}
    <button data-stoporder title="Leave the rest in the pile (Esc)">Stop</button>`;
  $('#pile').hidden = !pile.length;
  $('#pile').innerHTML = `<header><b>Unsorted pile (${pile.length})</b>${ordering ? '' : '<button data-startorder>Start ordering</button>'}</header>
    <div class="tiles">${pile.map(it => `<div class="tile ${it === pending ? 'current' : ''}" data-pick="${it.id}" title="${esc(it.title)} (click to place this one now)">
      ${thumbImg(it, '', ' loading="lazy"')}<span>${esc(it.title)}</span>
      <button data-discard="${it.id}" title="Remove from pile">✕</button></div>`).join('')}</div>`;
  const shown = items.map((it, i) => [it, i + 1]).filter(([it]) => matches(it));
  $('#fits').textContent = maxDur() == null ? '' : `${items.filter(fitsTime).length} of ${items.length} fit in ${fmtDur(maxDur())}`;
  $('#list').innerHTML = shown.length ? shown.map(([it, n]) => card(it, n)).join('') : `<li class="empty">${items.length ? 'Nothing matches those filters.' : 'Queue is empty. Paste a link above.'}</li>`;
  for (const img of document.querySelectorAll('img[data-thumb]')) seen.observe(img);
}

const find = el => {
  const id = el.closest('[data-id]')?.dataset.id;
  return items.find(i => i.id === id);
};

const complete = m => m.title && m.thumbnail && m.duration;

$('#maxdur').addEventListener('input', render);

$('#url').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#add').requestSubmit(); }
});

$('#add').onsubmit = async e => {
  e.preventDefault();
  const seen = new Map([...items.map((it, i) => [keyOf(it.url), `the queue at #${i + 1}`]), ...pile.map(it => [keyOf(it.url), 'the unsorted pile']), ...drafts.map(d => [keyOf(d.url), 'the details form'])]);
  const urls = [], skipped = [];
  for (const url of extractUrls($('#url').value)) {
    if (seen.has(keyOf(url))) skipped.push(`${url} (already in ${seen.get(keyOf(url))})`);
    else { seen.set(keyOf(url), 'this batch'); urls.push(url); }
  }
  if (!urls.length) return say(skipped.length ? 'Nothing new: ' + skipped.join('; ') : 'No links found.', true);
  say(`Fetching details for ${urls.length} link${urls.length > 1 ? 's' : ''}…`);
  const fetched = await Promise.all(urls.map(async url => {
    const r = await api('/api/meta', { method: 'POST', body: { url } }).catch(() => null);
    return r?.ok ? { url, meta: await r.json(), error: null } : { url, meta: { source: 'other' }, error: r ? await problem(r) : 'no connection' };
  }));
  $('#url').value = '';
  autoOrder = urls.length === 1;
  const ready = fetched.filter(d => complete(d.meta));
  ready.forEach(addToPile);
  drafts.push(...fetched.filter(d => !complete(d.meta)));
  if (ready.length) savePile();
  say([ready.length && `Added ${ready.length} to the pile.`, drafts.length && `${drafts.length} need${drafts.length === 1 ? 's' : ''} details: fill in the form below the link box.`, skipped.length && `Skipped duplicates: ${skipped.join('; ')}`].filter(Boolean).join(' '), skipped.length > 0);
  showDraft();
};

function addToPile({ url, meta }) {
  const it = { id: crypto.randomUUID(), url, ...meta };
  it.tags = autoTags(it);
  pile.push(it);
}

// the details form works through drafts one at a time, asking only for what the site didn't give
function showDraft() {
  const d = drafts[0];
  $('#manual').hidden = !d;
  if (!d) return afterAdding();
  const need = { 'm-title': !d.meta.title, 'm-thumb': !d.meta.thumbnail, 'm-dur': !d.meta.duration };
  for (const [id, missing] of Object.entries(need)) { $('#' + id).hidden = !missing; $('#' + id).required = missing; }
  $('#m-url').textContent = `${drafts.length > 1 ? `(${drafts.length} to fill) ` : ''}${d.error ? `Couldn't fetch details (${d.error}): ` : ''}${d.url}`;
  $('#manual input:not([hidden])').focus();
}

function afterAdding() {
  if (autoOrder && pile.length && !ordering) { autoOrder = false; pile.unshift(pile.pop()); ordering = true; } // place the single new link first
  next();
}

$('#manual').onsubmit = e => {
  e.preventDefault();
  const d = drafts.shift(), m = d.meta;
  m.title ||= $('#m-title').value.trim();
  m.thumbnail ||= $('#m-thumb').value.trim();
  m.duration ||= parseDur($('#m-dur').value.trim());
  $('#manual').reset();
  addToPile(d);
  savePile();
  say(''); // the "N need details" note is stale now; the form shows what's left
  showDraft();
};

function askRemove(it) {
  $('#ask').hidden = false;
  $('#ask').dataset.id = it.id;
  $('#ask').innerHTML = `<span>Done watching <b>${esc(it.title)}</b>? Remove it from the queue?</span><button data-askyes>Remove</button><button data-askno>Keep</button>`;
}

document.addEventListener('click', e => {
  const t = e.target;
  const link = t.closest('.item a');
  if (link) return askRemove(find(link)); // link still opens in its new tab
  if (t.dataset.askyes != null || t.dataset.askno != null) {
    if (t.dataset.askyes != null) { items = items.filter(i => i.id !== $('#ask').dataset.id); save(); render(); }
    $('#ask').hidden = true;
  } else if (t.dataset.manualcancel != null) {
    drafts.shift(); $('#manual').reset(); say(''); showDraft();
  } else if (t.dataset.startorder != null) {
    ordering = true; next();
  } else if (t.dataset.stoporder != null) {
    ordering = false; next();
  } else if (t.dataset.skip != null) {
    pile.push(pile.shift()); savePile(); next();
  } else if (t.dataset.discard) {
    const it = pile.find(i => i.id === t.dataset.discard);
    if (confirm(`Remove "${it.title}" from the pile?`)) { pile = pile.filter(i => i !== it); savePile(); next(); }
  } else if (t.dataset.pick) { // place this one now (starts ordering if needed)
    const it = pile.find(i => i.id === t.dataset.pick);
    pile = [it, ...pile.filter(i => i !== it)]; savePile();
    ordering = true; next();
  } else if (t.dataset.saverules != null) {
    rules = $('#rules').value;
    save().then(ok => ok && say('Tag rules saved.'));
  } else if (t.dataset.applyrules != null) {
    rules = $('#rules').value;
    let added = 0;
    for (const it of [...items, ...pile]) for (const tag of autoTags(it)) if (!it.tags.includes(tag)) { it.tags.push(tag); added++; }
    say(`Added ${added} tag${added === 1 ? '' : 's'} from rules.`);
    if (added) { save(); savePile(); }
    render();
  } else if (t.dataset.edit != null) {
    editing = find(t).id; render();
    $('#e-title').focus();
  } else if (t.dataset.editcancel != null) {
    editing = null; render();
  } else if (t.dataset.del != null) {
    const it = find(t);
    if (confirm(`Remove "${it.title}"?`)) { items = items.filter(i => i !== it); save(); render(); }
  } else if (t.dataset.untag != null) {
    const it = find(t);
    it.tags = it.tags.filter(x => x !== t.dataset.untag);
    save();
    render();
  } else if (t.dataset.facet && !pending) {
    const { facet, value } = t.dataset;
    filter[facet] = filter[facet] === value ? null : value;
    render();
  }
});

document.addEventListener('submit', e => {
  if (!e.target.matches('.editform')) return;
  e.preventDefault();
  const it = find(e.target), f = Object.fromEntries(new FormData(e.target));
  Object.assign(it, { title: f.title.trim(), creator: f.creator.trim() || undefined, url: f.url.trim(), thumbnail: f.thumbnail.trim(), duration: f.duration ? parseDur(f.duration.trim()) : undefined });
  editing = null;
  save(); render();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && editing) { editing = null; render(); }
  if (e.key === 'Escape' && ordering) { ordering = false; next(); }
  if (e.key !== 'Enter' || e.target.dataset.addtag == null) return;
  const tag = e.target.value.trim();
  const it = find(e.target);
  if (tag && !it.tags.includes(tag)) {
    it.tags.push(tag);
    save();
  }
  render();
  document.querySelector(`[data-id="${it.id}"] [data-addtag]`)?.focus();
});

// drag to reorder; works while filtered too (moves relative to the item you drop on)
const list = $('#list');
const clearOver = () => list.querySelectorAll('.over-top,.over-bottom').forEach(el => el.classList.remove('over-top', 'over-bottom'));
const below = (e, el) => { const r = el.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
list.addEventListener('dragstart', e => { dragId = e.target.dataset.id; e.target.classList.add('dragging'); });
list.addEventListener('dragend', e => { e.target.classList?.remove('dragging'); clearOver(); dragId = null; });
list.addEventListener('dragover', e => {
  const el = e.target.closest('.item');
  if (!dragId || !el || el.dataset.id === dragId) return;
  e.preventDefault();
  clearOver();
  el.classList.add(below(e, el) ? 'over-bottom' : 'over-top');
});
list.addEventListener('drop', e => {
  const el = e.target.closest('.item');
  if (!dragId || !el) return;
  e.preventDefault();
  const moved = items.find(i => i.id === dragId);
  items = items.filter(i => i !== moved);
  const at = items.findIndex(i => i.id === el.dataset.id) + (below(e, el) ? 1 : 0);
  items.splice(at, 0, moved);
  save(); render();
});

// placing: highlight the gap under the cursor, click inserts there (also works while filtered)
list.addEventListener('mousemove', e => {
  const el = e.target.closest('.item');
  if (!pending || !el) return;
  clearOver();
  el.classList.add(below(e, el) ? 'over-bottom' : 'over-top');
});
list.addEventListener('mouseleave', clearOver);
list.addEventListener('click', e => {
  const el = e.target.closest('.item');
  if (!pending || !el) return;
  e.stopPropagation();
  items.splice(items.findIndex(i => i.id === el.dataset.id) + (below(e, el) ? 1 : 0), 0, pending);
  pile = pile.filter(i => i !== pending);
  save(); savePile(); next();
});

// ---- getting in: an invite link, a list link, or the list this browser remembers
const KEY = 'watch-queue'; // { secret, next?, saved? }: next is a new link whose switch-over hasn't been confirmed
const recall = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const remember = list => localStorage.setItem(KEY, JSON.stringify(list));
const makeSecret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
console.assert(/^[\w-]{43}$/.test(makeSecret()), 'secret shape');
const myLink = () => `${location.origin}/#list=${secret}`;

function gate(text, more = '', go = null) {
  $('main').hidden = true;
  $('#gate').hidden = false;
  $('#gate-text').textContent = text;
  $('#gate-more').textContent = more;
  $('#gate-go').hidden = !go;
  if (go) { $('#gate-go').textContent = go.label; $('#gate-go').onclick = go.run; }
}

function showLink() {
  $('#mylink').value = myLink();
  $('#savelink').hidden = !!recall(KEY)?.saved;
}

async function openList() {
  let mine = recall(KEY);
  secret = mine.secret;
  const retry = { label: 'Try again', run: openList };
  let r = await api('/api/list').catch(() => null);
  if (r?.status === 401 && mine.next) {
    secret = mine.next;
    r = await api('/api/list').catch(() => null);
    if (r?.ok) remember({ secret });
  }
  if (!r) return gate("Can't reach the server.", '', retry);
  if (r.status === 401) return gate("This link doesn't open a list.", 'It may have been replaced by a newer one. Ask whoever invited you for a new link.');
  if (!r.ok) return gate(await problem(r), '', r.status === 403 ? null : retry);
  adopt(await r.json());
  showLink();
  $('#gate').hidden = true;
  $('main').hidden = false;
}

async function acceptInvite(code) {
  // kept before asking, so if the answer gets lost a second try opens the same list
  const kept = recall(KEY + '-invite');
  const fresh = kept?.code === code ? kept : { code, secret: makeSecret() };
  localStorage.setItem(KEY + '-invite', JSON.stringify(fresh));
  const r = await api('/api/invites/redeem', { method: 'POST', body: fresh }).catch(() => null);
  if (!r) return gate("Can't reach the server.", '', { label: 'Try again', run: () => acceptInvite(code) });
  if (!r.ok) return gate(r.status === 410 ? await problem(r) : "This invite isn't valid.", 'Invites work once. Ask whoever sent it for a new one.');
  remember({ secret: fresh.secret });
  localStorage.removeItem(KEY + '-invite');
  history.replaceState(null, '', '/');
  return openList();
}

async function start() {
  const link = new URLSearchParams(location.hash.slice(1));
  const opened = link.get('list'), invite = link.get('invite'), mine = recall(KEY);
  if (opened) {
    history.replaceState(null, '', '/'); // keep the secret out of history and screenshots
    if (mine && mine.secret !== opened && !confirm('This browser remembers a different list. Switch to this one? You will need the other list\'s link to get back to it.')) return openList();
    if (mine?.secret !== opened) remember({ secret: opened, saved: true });
    return openList();
  }
  if (invite && mine) return gate('This browser already has a list.', 'Open this invite in another browser to start a separate one.', { label: 'Open my list', run: () => { history.replaceState(null, '', '/'); openList(); } });
  if (invite) return gate("You're invited.", 'Keep one queue of everything you want to watch. This invite works once, and the list is yours.', { label: 'Start my list', run: () => acceptInvite(invite) });
  if (mine) return openList();
  return gate("It's invite only for now.", 'Already have a list? Open the link you saved.');
}
addEventListener('hashchange', () => { if (location.hash.length > 1) location.reload(); });

document.addEventListener('click', async e => {
  const t = e.target;
  if (t.dataset.copylink != null) {
    try {
      await navigator.clipboard.writeText(myLink());
      remember({ ...recall(KEY), saved: true });
      showLink();
      say('Link copied. Keep it somewhere safe.');
    } catch {
      $('#link-panel').open = true;
      $('#mylink').select();
      say("Couldn't copy. Copy the selected link by hand.", true);
    }
  } else if (t.dataset.linksaved != null) {
    remember({ ...recall(KEY), saved: true });
    showLink();
  } else if (t.dataset.newlink != null) {
    if (!confirm('Make a new link? The current one stops working everywhere, including your other devices.')) return;
    const next = makeSecret();
    remember({ ...recall(KEY), next });
    await saving;
    const r = await api('/api/list/secret', { method: 'POST', body: { secret: next } }).catch(() => null);
    if (!r) return say("Couldn't confirm the new link. Reload the page to check.", true);
    if (!r.ok) return say("Couldn't make a new link: " + await problem(r), true);
    secret = next;
    remember({ secret });
    showLink();
    say('New link made. Save it.');
  } else if (t.dataset.export != null) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ items, pile, rules }, null, 2)], { type: 'application/json' })), download: 'watch-queue.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  } else if (t.dataset.import != null) {
    $('#importfile').click();
  }
});

$('#importfile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { return say("That file isn't a Watch Queue backup.", true); }
  if (!Array.isArray(backup?.items) || !Array.isArray(backup.pile)) return say("That file isn't a Watch Queue backup.", true);
  if (!confirm(`Replace this list with the ${backup.items.length + backup.pile.length} items in the backup?`)) return;
  // sent to the server first: it checks the file, and only a good one is shown
  saving = saving.then(async () => {
    const r = await api('/api/list', { method: 'PUT', body: { version, content: { items: backup.items, pile: backup.pile, rules: String(backup.rules ?? '') } } }).catch(() => null);
    if (!r?.ok) return say('Import failed: ' + (r ? r.status === 409 ? 'the list changed elsewhere. Reload and try again.' : await problem(r) : 'no connection'), true);
    const now = await api('/api/list').catch(() => null);
    if (!now?.ok) return say('Imported. Reload the page to see it.');
    adopt(await now.json());
    say('Backup imported.');
  });
};

start();
