'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the browser controller without real accounts or modifying a running
// user's session. Only the DOM operations used by the Spotify view are needed.
function browser(previewResponse) {
  class Element {
    constructor() { this.children = []; this.textContent = ''; this.scrolled = false; this.focused = false; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return []; }
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
    window, URLSearchParams, location: { search: '' }, history: { replaceState() {} },
    document: { getElementById: element, createElement: () => new Element() },
    fetch: async url => {
      requests.push(url);
      const body = url.endsWith('/api/status') ? { ok: true, userId: 'user', playlists: [] }
        : url.endsWith('/api/playlists') ? { ok: true, playlists: [{ id: 'playlist', name: 'Release Radar', owned: false }] }
        : previewResponse;
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
