'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the browser controller without real accounts or modifying a running
// user's session. Only the DOM operations used by the Spotify view are needed.
function browser(previewResponse, matchResponse = () => { throw new Error('Unexpected match request'); }) {
  class Element {
    constructor() { this.children = []; this.textContent = ''; this.scrolled = false; this.focused = false; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    querySelectorAll(selector) { return this.children.flatMap(child => [ ...(child.tag === selector ? [child] : []), ...child.querySelectorAll(selector) ]); }
    replaceWith(next) { const index = this.parent.children.indexOf(this); this.parent.children[index] = next; next.parent = this.parent; }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    setAttribute() {}
    add(option) { this.append(option); }
    scrollIntoView() { this.scrolled = true; }
    focus() { this.focused = true; }
  }
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const requests = [];
  const window = {};
  const context = vm.createContext({
    window, URLSearchParams, Option: function(text, value) { return Object.assign(new Element(), { text, value }); }, location: { search: '' }, history: { replaceState() {} },
    document: { getElementById: element, createElement: tag => Object.assign(new Element(), { tag }) },
    fetch: async (url, options) => {
      requests.push(url);
      const body = url.endsWith('/api/status') ? { ok: true, userId: 'user', playlists: [] }
        : url.endsWith('/api/playlists') ? { ok: true, playlists: [{ id: 'playlist', name: 'Release Radar', owned: false }] }
         : url.endsWith('/match') ? await matchResponse(JSON.parse(options.body)) : previewResponse;
      return { ok: body.ok, json: async () => body };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/spotify.js'), 'utf8'), context);
  return { element, requests, open: () => window.navilistSpotify.open(),
    preview: () => element('sp-playlists').children[0].children[0].children[1].children[0].onclick() };
}

test('Preview remains available for non-owned playlists and reveals the results with counts', async () => {
  const ui = browser({ ok: true, playlist: { spotify_id: 'playlist', title: 'Release Radar', total: 20,
    matched: 12, missing: 6, review: 2, unsupported: 0, tracks: [] } });
  await ui.open();
  await ui.preview();
  assert.ok(ui.requests.includes('/spotify/api/playlists/playlist/preview'));
  assert.match(ui.element('sp-message').textContent, /20 items.*12 matched, 6 missing, 2 need review/);
  assert.match(ui.element('sp-message').textContent, /nothing imported/);
  assert.equal(ui.element('sp-preview').hidden, false);
  assert.equal(ui.element('sp-preview').scrolled, true);
  assert.equal(ui.element('sp-previewTitle').focused, true);
  assert.equal(ui.element('sp-subscribe').disabled, false);
  assert.ok(!ui.requests.some(url => url.endsWith('/subscribe')));
});

test('an empty preview explicitly reports no items instead of Done', async () => {
  const ui = browser({ ok: true, playlist: { spotify_id: 'playlist', title: 'Release Radar', total: 0,
    matched: 0, missing: 0, review: 0, unsupported: 0, tracks: [] } });
  await ui.open(); await ui.preview();
  assert.match(ui.element('sp-message').textContent, /returned no items/);
  assert.equal(ui.element('sp-subscribe').disabled, true);
});

test('a denied preview shows the error and does not reveal stale results', async () => {
  const ui = browser({ ok: false, error: 'Cannot read playlist tracks: Spotify API error (403): Forbidden' });
  await ui.open(); await ui.preview();
  assert.match(ui.element('sp-message').textContent, /403.*Forbidden/);
  assert.equal(ui.element('sp-preview').hidden, true);
  assert.equal(ui.element('sp-preview').scrolled, false);
});

function reviewTrack(position, spotify_id = `song-${position}`) {
  return { position, spotify_id, artist: 'Artist', title: `Song ${position}`, status: 'review', track_id: null,
    candidates: [{ id: 'local', artist: 'Artist', title: 'Song', score: 90 }] };
}
function largePreview(tracks) {
  return { ok: true, playlist: { spotify_id: 'playlist', title: 'Huge playlist', total: tracks.length,
    matched: 0, missing: 0, review: tracks.length, unsupported: 0, tracks: tracks.map(track => ({ ...track })) } };
}

test('match saves keep unrelated rows usable, allow the next selection and update duplicate counts in place', async () => {
  const tracks = Array.from({ length: 2000 }, (_, i) => reviewTrack(i));
  tracks[1500].spotify_id = tracks[0].spotify_id;
  const pending = new Map();
  const ui = browser(largePreview(tracks), body => new Promise(resolve => pending.set(body.spotify_id, resolve)));
  await ui.open(); await ui.preview();
  const rows = ui.element('sp-tracks'), nextRow = rows.children[1], untouched = rows.children[1999];
  const choose = row => { const select = row.children[3].children[0]; select.value = 'local'; return select.onchange(); };
  const first = choose(rows.children[0]);
  assert.equal(nextRow.children[3].children[0].disabled, false);
  assert.equal(rows.children[1500].children[3].children[0].disabled, true);
  const second = choose(nextRow);
  assert.equal(pending.size, 2);
  const finish = sourceId => pending.get(sourceId)({ ok: true, update: { spotify_id: 'playlist',
    tracks: tracks.filter(track => track.spotify_id === sourceId).map(track => ({ ...track, track_id: 'local', status: 'matched', candidates: [] })) } });
  finish('song-1'); await second;
  finish('song-0'); await first;
  assert.equal(rows.children[1999], untouched);
  assert.equal(rows.children.length, 2000);
  assert.match(ui.element('sp-summary').textContent, /3 matched.*1997 need review/);
  assert.equal(ui.requests.filter(url => url.endsWith('/api/status')).length, 3); // open + open finalization + preview finalization only
});

test('a failed match keeps the choice retryable without redrawing unrelated rows', async () => {
  const ui = browser(largePreview([reviewTrack(0), reviewTrack(1)]), async () => ({ ok: false, error: 'Save failed' }));
  await ui.open(); await ui.preview();
  const rows = ui.element('sp-tracks'), next = rows.children[1];
  const select = rows.children[0].children[3].children[0]; select.value = 'local'; await select.onchange();
  assert.equal(rows.children[1], next);
  assert.equal(rows.children[0].children[3].children[0].disabled, false);
  assert.match(ui.element('sp-message').textContent, /Save failed/);
  assert.match(ui.element('sp-summary').textContent, /0 matched.*2 need review/);
});

test('missing-only view removes matched duplicates without disturbing the next row, and reset restores review counts', async () => {
  const tracks = [reviewTrack(0), reviewTrack(1), reviewTrack(2, 'song-0')];
  const ui = browser(largePreview(tracks), async body => ({ ok: true, update: { spotify_id: 'playlist',
    tracks: tracks.filter(track => track.spotify_id === body.spotify_id).map(track => body.track_id === null
      ? track : { ...track, track_id: 'local', status: 'matched', candidates: [] }) } }));
  await ui.open(); await ui.preview();
  ui.element('sp-missingOnly').checked = true; ui.element('sp-missingOnly').onchange();
  const rows = ui.element('sp-tracks'), next = rows.children[1];
  const select = rows.children[0].children[3].children[0]; select.value = 'local'; await select.onchange();
  assert.equal(rows.children.length, 1); assert.equal(rows.children[0], next);
  assert.match(ui.element('sp-summary').textContent, /2 matched.*1 need review/);
  ui.element('sp-missingOnly').checked = false; ui.element('sp-missingOnly').onchange();
  await rows.children[0].children[3].children[0].onclick();
  assert.match(ui.element('sp-summary').textContent, /0 matched.*3 need review/);
  assert.equal(rows.children[0].children[3].children[0].disabled, false);
});
