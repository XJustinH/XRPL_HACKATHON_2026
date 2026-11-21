# Spotify now-playing (XRPL-092)

An optional, Discord-style "listening to" status. A customer can connect their Spotify account, see
what they are playing on their own profile, and choose whether friends or everyone can see it too.
Nothing is connected, read or shown unless the customer asks for it, and the feature is switched
off entirely on a deployment that has no Spotify app configured.

Code: `src/features/integrations/spotify/`, routes under `src/app/api/integrations/spotify/`,
contracts in `src/contracts/integrations.ts`, table `SpotifyConnection`.

> **Not verified against the real Spotify.** No Spotify app was available while this was built.
> Every test fakes Spotify (`testing/fakes.ts`). Before relying on it, run the live check at the
> end of this page with a real Spotify app.

## Setting it up

1. Go to <https://developer.spotify.com/dashboard> and create an app. Choose **Web API**.
2. Add a **Redirect URI** that matches `SPOTIFY_REDIRECT_URI` exactly (scheme, host, port, path):
   - deployed: `https://<your-domain>/api/integrations/spotify/callback`
   - local: `http://127.0.0.1:3000/api/integrations/spotify/callback`. Spotify's redirect URI rules
     allow plain http only for a loopback IP address, and not for `localhost`.
3. Copy the **Client ID** (and, if you want, the client secret) into the environment.
4. A new Spotify app starts in Development Mode: only Spotify accounts you add under the app's
   **User Management** can connect. Check the dashboard for the current limits.

| Variable | Required | Meaning |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | to enable | The app's client ID. Blank means "not configured". |
| `SPOTIFY_CLIENT_SECRET` | no | Optional. PKCE works without it. If set it is sent as HTTP Basic auth to the token endpoint. Server-only. |
| `SPOTIFY_REDIRECT_URI` | no | Defaults to `<APP_BASE_URL>/api/integrations/spotify/callback`. |
| `SESSION_SECRET` | to enable | Already required in production. The token and cookie encryption keys are derived from it, so Spotify stays "not configured" without it (32+ characters). |

Running locally: cookies belong to one host, so use the same host everywhere. Set
`APP_BASE_URL=http://127.0.0.1:3000`, leave `SPOTIFY_REDIRECT_URI` blank (or set it to the loopback
URL above), and open the app at `http://127.0.0.1:3000`, not `http://localhost:3000`.

When Spotify is not configured, `GET /api/integrations/spotify/connect` answers
`503 { "error": { "code": "SPOTIFY_NOT_CONFIGURED" } }`, the panel says "Spotify isn't set up on
this deployment", and every now-playing read is empty. Nothing else in the app changes.

## Routes

| Method | Route | What it does |
|---|---|---|
| GET | `/api/integrations/spotify/connect` | Signed-in only. Starts Authorization Code with PKCE and redirects to Spotify's consent screen. |
| GET | `/api/integrations/spotify/callback` | Verifies the state, exchanges the code, stores the encrypted tokens, then redirects to `/profile?spotify=<result>` (`connected`, `denied`, `invalid_state`, `signed_out`, `failed`). |
| GET | `/api/integrations/spotify` | The caller's own connection: `{ configured, connected, spotifyDisplayName, visibility }`. |
| PATCH | `/api/integrations/spotify` | `{ visibility: "ONLY_ME" \| "FRIENDS" \| "EVERYONE" }`. Needs a connection (409 otherwise). |
| DELETE | `/api/integrations/spotify` | Disconnect: deletes the stored tokens and resets visibility to private. Idempotent. |
| GET | `/api/integrations/spotify/now-playing?userId=…` | `{ userId, track }`. `userId` defaults to the caller. `track` is null unless the viewer may see it and something is playing. |

`GET` and `PATCH` on `/api/integrations/spotify` are additions to the endpoint catalogue: the
visibility choice needs somewhere to be read and saved.

## Consent and visibility

- **Connecting is explicit.** The only way to create a connection is to press "Connect Spotify"
  and approve on Spotify's own consent screen (`show_dialog=true`, so it is shown every time). The
  only scope requested is `user-read-currently-playing`.
- **Private by default.** A new connection is visible to its owner only. Showing it to anyone else
  is a second, separate choice, stored in `User.settings.spotifyVisibility`. A missing or
  unreadable value reads as `ONLY_ME`. Every new connection starts private again, whatever was
  chosen before.
- **Who sees it** (`canViewNowPlaying` in `visibility.ts`, applied by `getNowPlayingForViewer` in
  `server.ts`):

  | Setting | Owner | Accepted friend | Anyone else, signed in or not |
  |---|---|---|---|
  | `ONLY_ME` (default) | yes | no | no |
  | `FRIENDS` | yes | yes | no |
  | `EVERYONE`, public profile | yes | yes | yes |
  | `EVERYONE`, private profile | yes | yes | no |

  A viewer blocked in either direction never sees it. Friendship is asked of the friend service
  (`areFriends`, XRPL-084), and if that or the block lookup fails the answer is "no".
- **Decided on the server, before Spotify is called.** A viewer who may not see the status never
  causes the owner's token to be used, and gets the same empty answer as for "not connected",
  "nothing playing" and an unknown user, so the route cannot be used to find out who has connected.
- **Disconnecting** deletes the tokens held here. Spotify offers no way for an app to withdraw its
  own grant, so the panel also links to <https://www.spotify.com/account/apps/>.

## Token handling

- The access and refresh tokens are stored only in `SpotifyConnection.accessTokenEnc` and
  `refreshTokenEnc`, encrypted with AES-256-GCM (`secret-box.ts`). The key is derived from
  `SESSION_SECRET` with HKDF-SHA-256, with a random 96-bit IV per value and the user ID as
  additional authenticated data, so one user's stored token cannot be opened as another's.
- Tokens are decrypted only inside `SpotifyService`, for the one call that needs them. No route,
  component or contract carries a token, and nothing logs one: Spotify errors are reduced to a kind
  and an HTTP status.
- The OAuth cookie (`xt_spotify_oauth`, or `__Secure-xt_spotify_oauth` over https) holds the PKCE
  verifier and the state, encrypted under a different derived key with the session ID as additional
  data. It is httpOnly, `SameSite=Lax`, scoped to `/api/integrations/spotify`, lives ten minutes and
  is cleared by the callback. The callback is rejected unless that cookie opens in the current
  session and its state equals the one Spotify returned.
- Rotating `SESSION_SECRET` makes stored tokens unreadable. The next read removes such a
  connection and the customer connects again.
- Deleting a user deletes their connection (`ON DELETE CASCADE`).

## Failure behaviour

| Situation | Result |
|---|---|
| Access token expired | Refreshed with the refresh token; the new pair is stored encrypted. |
| Access token rejected early (401) | Refreshed once and retried. |
| Refresh token refused (`invalid_grant`), or 401 with a fresh token | The connection is deleted; the panel shows "not connected" with a note. |
| Nothing playing (204), paused, or not a music track | Empty status; nothing is shown. |
| Spotify error, rate limit (429), timeout (4 s) or network failure | Empty status; the connection is kept. Never an error page. |
| Token exchange fails in the callback | Nothing is stored; `/profile?spotify=failed`. |
| Consent refused on Spotify | Nothing is stored; `/profile?spotify=denied`. |

A refresh that races another one is not mistaken for a revocation: if the stored refresh token
changed in the meantime, the newer tokens are used instead of deleting the connection.

## Where the UI goes

Both components are Server Components and decide what to render themselves.

- `SpotifyPanel` (`src/features/integrations/spotify/spotify-panel.tsx`): the owner's settings,
  for `/profile`. No props: `<SpotifyPanel />`. It reads `?spotify=<result>` to report the outcome.
- `NowPlayingBadge` (`src/features/integrations/spotify/now-playing-badge.tsx`): for another
  person's profile. `<NowPlayingBadge userId={profile.userId} viewer={session} />`, where `viewer`
  is the current session or null. Renders nothing unless the viewer may see a playing track.

## Tests

Spotify is always faked; no test touches the network.

```bash
npx vitest run --project unit src/features/integrations
TEST_DATABASE_URL=... npx vitest run --project db src/features/integrations
```

## Live check (needs a real Spotify app)

1. Configure the variables above and sign in at `/profile`.
2. Press "Connect Spotify", approve, and confirm the panel shows "Connected as ...".
3. Play a track in Spotify and reload: the panel shows it. Pause: it shows "Nothing playing".
4. Open your `/customers/<id>` page in a private window: nothing while "Only me"; the track after
   choosing "Everyone".
5. Wait an hour (or set `accessTokenExpiresAt` to the past) and reload: the track still shows.
6. Remove the app at <https://www.spotify.com/account/apps/>, expire the token again, reload: the
   panel returns to "not connected".
7. Press "Disconnect Spotify" and check the `SpotifyConnection` row is gone.

## Limitations

- Not verified against the real Spotify (see the top of this page). In particular, sending the
  client secret together with a PKCE verifier, and reading the display name from `GET /v1/me`
  without a profile scope, follow Spotify's documentation but have not been observed working. The
  display name is optional: without it the panel says "Connected".
- Friendships: the friend service on `main` still has no storage and answers 503, which this
  feature treats as "not a friend". Until that lands, `FRIENDS` (and `EVERYONE` on a private
  profile) shows the status to the owner only.
- The status is read from Spotify on each page view, with no cache and no live updates. A busy
  public profile could reach Spotify's rate limit, which shows as "nothing playing".
- Podcasts and adverts show nothing: only tracks are reported.
- A demo persona is a shared account, so a Spotify connection made on one is visible to everyone
  who signs in as it. The panel says so before connecting.
