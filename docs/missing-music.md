# Missing Music (local development)

**Missing Music** is a global navigation tab at `/missing-music`. It is organized
as **artist → album → unmatched tracks**, with lazy expandable groups, search by
artist/album/track, source and status filters, and 30 artists per page.

## Queue sources

- Cached Spotify playlist previews and subscriptions (including playlists whose
  tracks Spotify actually allowed us to retrieve).
- Cached Last.fm and ListenBrainz playlist tracks.
- naviList's existing `missing_artists` queue, including file-import artists.
- Previously requested/ignored items, so decisions and errors remain inspectable.

Tracks are rematched against the local Navidrome library on refresh. Existing
Spotify match overrides are respected. Duplicate songs across playlists are
grouped, with all source playlists shown. This is **not a view of Lidarr's whole
Wanted catalog**, and no live Spotify fetch or Lidarr write occurs when browsing.

Album names are currently available from Spotify's cached metadata. Last.fm,
ListenBrainz and the legacy artist queue may not supply albums; those tracks are
shown under **Album information not provided**, rather than guessing an album.
Historical file imports contribute artists, not album data they never stored.

An unmatched track can be a metadata/version mismatch, not absent audio. Check
playlist matching before requesting music. A song already matched to a local
version is not a missing-song request just because Spotify names another album.

## Individual review and requests

1. Expand an artist, then an album (when known).
2. Choose **Review artist/album in Lidarr**. This is a read-only metadata lookup.
3. Edit the search if needed and **select** the correct candidate. No result is
   silently selected; disambiguation, release year and type are shown when supplied.
4. Review the action, configured root folder and profile IDs.
5. For albums, choose whether to search now or only monitor. Check the explicit
   confirmation, then send the single item.

**Artist additions** default to no albums monitored, no future albums auto-monitored
and no artist-wide search. An existing artist is left unchanged when the option
below is off. This intentionally differs from the older bulk-send behavior.

The artist review has an opt-in **Monitor missing albums** checkbox, off by
default. Changing it clears the confirmation checkbox so the changed scope must
be approved again:
- New artists use Lidarr's `missing` monitoring mode, with future/new-album
  auto-monitoring disabled and `searchForMissingAlbums: false`.
- For existing active artists, only already-released albums with a verified zero
  file count are enabled. Albums with any files, upcoming/unknown releases, missing
  statistics and other monitoring preferences are left alone. A paused artist must
  first be enabled in Lidarr; this UI will not silently resume it.
- No immediate catalog search is requested, but **normal Lidarr automation may
  acquire matching releases once albums are monitored**. Monitoring is not a promise
  that nothing will download later. Unchecking does not undo existing monitoring.
- An earlier plain artist addition can be explicitly upgraded to missing-album
  monitoring; repeat successful monitoring requests are deduplicated until reset.

For an immediate search, review/request an individual album instead.

**Album requests** target the selected MusicBrainz release-group ID. A new artist
is added with no catalog monitoring/search. Existing albums use a single-album
monitor update and, only when approved, `AlbumSearch` for that one album ID.
Existing unrelated artist/album preferences are not changed. If an existing artist
is unmonitored, enable it in Lidarr first; this UI does not silently enable it.

If Lidarr already reports all album files, no new search is sent; refresh Navidrome
and review matching instead. **Search requested** means Lidarr accepted a request,
not that indexers found a release or a download completed. Completed items become
available when the cached source tracks match Navidrome after its library sync.

## Manual mode and safeguards

- Keep **Lidarr auto-add off** in Settings. The page warns when it is enabled and
  offers an explicit **Use manual mode** action to turn it off. This does not
  cancel an older bulk operation already in progress, existing monitoring or downloads.
- Ignoring an artist hides its album gaps too; restore the artist to request them.
  Ignore is a queue decision, not a Lidarr cancellation command.
- Confirmations are bound to one item and the exact server-side lookup candidates,
  expire after ten minutes, and are invalidated by Lidarr configuration changes.
- Requests are serialized. Previously successful requests for the same candidate
  are not automatically repeated, even from another queue entry. A monitor-only
  album request can later be explicitly upgraded to a search.
- **Reset to pending** explicitly permits reviewing and sending a successful item
  again (for example, to retry a search later). It does not cancel prior activity;
  a new confirmation is still required and may start another search.
- Errors are retained. A timeout may mean Lidarr applied part of the action:
  inspect Lidarr before retrying with a fresh review. No automatic retries of writes.
- If a library gap is resolved while a review is open, sending it is rejected.
- All mutation endpoints require a same-origin browser request. As with upstream
  naviList, this is not a replacement for your LAN/WireGuard or authenticated ingress.
- Credentials never appear in the queue/review API. No real Lidarr requests are
  made by the automated tests or the local mock fixture server.

The database addition is the additive `missing_music_actions` table, including a
`monitor_missing` decision flag. Earlier local versions of this table are upgraded
additively without resetting decisions. No existing library, playlist or credential
tables are rebuilt or discarded by this feature.

## Verification / deployment boundary

Run the isolated fixture UI with the supported prototype runtime (Node 20):

```sh
npm run demo:missing-music
```

On a workstation whose default Node version is 24, use the prototype's Node 20
runtime explicitly instead:

```sh
npm exec --yes --package=node@20 -- node scripts/demo-missing-music.cjs
```

Then open <http://127.0.0.1:3141/missing-music>. It has 95 sample artists, multiple
albums, unknown-album tracks, error/ignored states and a fake Lidarr transport.
Its database is always in memory and it never loads real credentials or uses the
real Lidarr provider, even if a `.env` exists. Only the Missing Music view is wired
up in this fixture server; use the normal app to test other pages. Demo endpoints
are not registered in the normal application.

Local service, provider and HTTP tests use in-memory SQLite and mocked transport.
The browser fixture exercises many artist groups without any real credentials.
The provider payloads were checked against Lidarr's published v1 API controllers.
Actual Lidarr-version compatibility still needs a deliberate live test after review.

Additional local checks completed:
- Browsed a 95-artist fixture with pagination, source filters, search, nested
  albums/tracks, metadata selection, confirmation and a mock single-album request.
- Checked a 375px viewport without horizontal overflow.
- Lighthouse's initial queue-page accessibility audit scored 100 in both light
  and dark themes (this is an automated check, not a complete accessibility certification).
- Started the Linux image as UID/GID 1000 with no network and disposable data:
  health, queue HTML/API and SQLite integrity checks passed.
- Applied the additive schema to an isolated copy of the repaired backup:
  core row counts/settings were preserved and integrity/foreign-key checks passed.

This feature must **not be deployed automatically**. Review the local changes and
confirm deployment before building/importing a new image into the homelab.
