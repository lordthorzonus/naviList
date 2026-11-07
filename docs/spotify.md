# Spotify playlist syncing (experimental fork)

This fork adds **Spotify** under **Playlists → + New Playlist**, alongside Last.fm
and ListenBrainz. Account setup lives in **Settings → Spotify**. It matches tracks already in
Navidrome, reports missing tracks, and mirrors selected accessible Spotify
playlists. It never downloads music or writes to Spotify.

## What works

- OAuth authorization code flow with PKCE, browser-bound state and read-only scopes.
- Automatic access-token refresh; AES-256-GCM encryption of persisted tokens.
- Paginated playlist selection and matching preview before enabling sync.
- Existing naviList exact/normalized matching and fuzzy suggestions for review.
  Fuzzy suggestions are never selected automatically. Confirmed choices are
  remembered by Spotify track ID, across playlists. Reset choice removes the
  override; it does not force the track to remain unmatched.
- One-way additions, removals, renames, ordering and duplicates in Navidrome.
- Source snapshot caching and output fingerprints avoid unnecessary reads/writes.
- Polling on startup and every 30 minutes using naviList's service scheduler.
- Cached tracks are rematched after successful Navidrome library syncs, without
  waiting for the Spotify playlist to change or requesting Spotify again.
- Per-playlist errors, check times, successful-sync times, and missing-track lists.
- Stopping sync and disconnecting leave destination playlists in Navidrome.

## Boundaries and safety

- The Spotify developer-app owner needs **Premium**. Personal development-mode
  apps have an allowlist; add your account in the developer dashboard if needed.
- Preview attempts to read tracks for **any listed playlist**, including Release
  Radar, Discover Weekly, collaborative and followed playlists. Ownership alone
  neither enables nor blocks importing. Spotify's development-mode restrictions
  may deny track access even when playlist metadata is visible. Only successful
  track retrieval allows preview/import; failures preserve the cache and destination.
  Being listed is not proof that a playlist can be synced.
- A manual copy of Release Radar into an owned playlist can be synced, but the
  copy does **not** automatically follow future Release Radar changes.
- Only one Spotify account is supported. Disconnect before changing accounts.
  Disconnect forgets Spotify subscriptions, cached source tracks and match
  overrides. It does not revoke the app in Spotify; you can do that in Spotify's
  account settings.
- Empty and wholly unmatched sources **never replace a destination**. This is a
  conservative MVP rule, including when you intentionally empty Spotify's list.
  Stop sync and delete the destination yourself if that is what you want.
- Unsupported/unavailable items (episodes, Spotify-local files, null tracks)
  remain visible in the report but are not published. Other missing songs are
  skipped until they can be matched.
- Editing a managed playlist directly in Navidrome is not a supported workflow.
  A later source or match change can overwrite those edits. A deleted destination
  outside naviList may require stopping sync and resolving the stale subscription;
  automatic recovery from external deletion is not implemented.
- Matching currently reuses naviList's artist/title logic, using Spotify's first
  artist for matching. It does not add ISRC matching or duration/album scoring.
- Spotify publishing disables the detached studio-refinement job so it cannot
  overwrite a saved match or unexpectedly change the mirrored playlist.
- The existing generic registry snapshot deduplicates repeated local IDs; the
  Spotify report and actual Navidrome playlist retain duplicates and their order.
- Rate-limit responses pause Spotify API calls until `Retry-After`; Spotify network
  requests time out after 30 seconds. A Spotify retrieval error keeps the last successful source
  cache and destination. Navidrome track replacement and metadata updates are
  separate upstream API calls, so failures between them are retried, not atomic.

## 1. Create a Spotify developer app

1. Open <https://developer.spotify.com/dashboard> and create an app for personal use.
2. Select Web API access and register this **exact** redirect URI:

   ```text
   https://YOUR_NAVILIST_HOST/spotify/callback
   ```

3. Copy its client ID and secret into naviList's **Settings → Spotify** section
   (not a Git repository).
4. Ensure your Spotify account is allowed to use the app.

Use the externally visible HTTPS URL, including any non-default port. This MVP
assumes naviList is served at the domain root, not under a URL subpath. For local
testing Spotify permits a loopback IP such as
`http://127.0.0.1:3000/spotify/callback`, not `localhost`.

## 2. Configure credentials

In **Settings → Spotify**, enter the client ID, client secret and exact registered
callback URL. Click **Save Spotify settings**, then **Connect Spotify**. The secret
is encrypted in the database and never returned by the settings API. Leaving its
field blank keeps the saved value. Changes take effect without restarting the pod.
Disconnect first if you need to change app details; disconnecting keeps these
settings and the Navidrome playlists, but forgets subscriptions and match choices.

Only the encryption key is required in the deployment environment:

| Variable | Value |
| --- | --- |
| `SPOTIFY_TOKEN_KEY` | Random 32-byte key encoded as 64 hexadecimal characters |

Generate the encryption key once:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep the key stable across restarts and back it up securely alongside database
backups. Losing or changing it requires reconnecting Spotify. The token data is
in separate database tables, not the generic UI-readable settings table. The
encryption key is never stored in the database or exposed through the UI.

For deployments managed entirely through configuration, `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET` and `SPOTIFY_REDIRECT_URI` remain optional environment
defaults. UI-saved values take precedence over these defaults.

For Kubernetes, create a Secret named `navilist-spotify` in naviList's namespace
with the `SPOTIFY_TOKEN_KEY` key. Use your existing secret manager / ExternalSecret /
SOPS workflow. Do not put real values into the example deployment patch or share
client secrets in chat.

## 3. Build and test safely in Kubernetes

Build the existing Dockerfile and push to a registry your cluster can pull:

```sh
docker build -t YOUR_REGISTRY/navilist:spotify-test .
docker push YOUR_REGISTRY/navilist:spotify-test
```

Prefer a separate test deployment with its **own data PVC and hostname**. Start
with a fresh database and configure Navidrome as usual. Do not mount a live
SQLite PVC into two naviList instances. The test app can connect to the same
Navidrome instance, so use a distinctive Spotify test playlist name.

For an eventual in-place upgrade:

1. Record the current image and deployment configuration for rollback.
2. Stop naviList writes and take a consistent PVC/database backup (including any
   SQLite WAL state). A raw copy of only an active `.db` file is not a safe backup.
3. Customize `deploy/kubernetes/spotify-deployment-patch.yaml`: deployment name,
   container name and image. Do not apply it with placeholders unchanged.
4. Apply the patch in the correct namespace:

   ```sh
   kubectl -n YOUR_NAMESPACE patch deployment YOUR_DEPLOYMENT --type strategic --patch-file deploy/kubernetes/spotify-deployment-patch.yaml
   ```

5. Keep one replica and the Recreate strategy so rollouts cannot run two instances
   against SQLite or execute duplicate background jobs. A StatefulSet needs the
   equivalent changes in its own manifest, not this Deployment patch.
6. Keep the existing `/app/data` PVC, Navidrome settings, NSP mounts, ingress and
   readiness/liveness probes. `/health` remains available.

**Protect the entire app with your trusted network or authenticated ingress.**
Upstream naviList has no application-level login; this feature does not add one.
The OAuth flow protects authorization state and Spotify POSTs require the
configured browser origin, but neither is a replacement for authenticating users
of naviList. Ensure your ingress access logs redact callback query strings;
the application HTTP logger omits query strings to avoid recording OAuth codes.
OAuth state is held in memory for ten minutes, so reconnect if the pod restarts
during login. Kubernetes Secrets also need appropriate RBAC and at-rest protection.

## 4. First live test

1. Sync the Navidrome library in **Services**.
2. Open **Settings → Spotify**, save app details, click **Connect Spotify**, and authorize.
3. Open **Playlists → + New Playlist → Spotify → Continue**, then **Preview** an owned test playlist.
4. Check the matched/missing report and confirm any fuzzy suggestions.
5. Click **Subscribe** and verify the new playlist in Navidrome.
6. Reorder/add/remove a song in Spotify and click **Sync now**.
7. Add a missing song to Navidrome, sync its library in naviList, and verify it
   appears without editing the Spotify playlist.
8. Click **Stop syncing** and verify later Spotify edits do not update Navidrome.

Do not enable a second subscription to an already-imported playlist and expect
the app to adopt the old destination by name: it deliberately creates and tracks
its own destination ID rather than overwriting unrelated playlists.

## Local development and verification

### Windows / WSL image iteration (no registry)

With Docker Engine and Buildx running inside the `archlinux` WSL2 distro, run
from PowerShell:

```powershell
.\scripts\build-dev.ps1 -Export
```

This builds a unique `linux/amd64` image, runs the test suite inside it, and exports
an image archive under `%LOCALAPPDATA%\Temp\opencode\navilist-images`. Omit
`-Export` to only build/test; use `-Distro` or `-Tag` to override the defaults.
The script never pushes to a registry or changes Kubernetes. Image transfer,
containerd import and rollout are separate operations. The Dockerfile normalizes
the entrypoint's line endings so Windows checkouts work in Linux containers.

Upstream's native `better-sqlite3` version and Dockerfile currently target Node 20.
Node 24 cannot build that dependency unchanged. Use the existing Node 20 runtime
for this prototype; upgrading the inherited runtime/dependencies is separate work
before production hardening (Node 20 is no longer an actively supported release).

```sh
npm ci
npm test
```

Set `DB_PATH` to a writable file or `:memory:` for local experiments; the upstream
default is `/app/data/navilist.db`. Supply configuration via a local ignored `.env`
file and run `npm start`.

Tests use in-memory SQLite, fake Spotify responses and fake Navidrome responses;
HTTP tests exercise OAuth state, origin checks and masked settings. No live accounts or cluster
access are used. Live Spotify/Navidrome validation still needs your setup.

The inherited dependency tree also has npm audit advisories; this feature does
not automatically apply unrelated major-version upgrades. Review `npm audit`
before exposing the prototype beyond a trusted environment.
