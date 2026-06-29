# gravclone — agent instructions

Canonical flow for cloning a publisher site and sharing a live demo URL.

## 1. Clone

```bash
# Without auth (public site)
gravclone <url> [port] [notes]

# With auth (real logged-in UI — required when the demo target is gated)
gravclone chrome                 # launches a stealth Chrome that clones the user's real profile
# user logs into the target site in that Chrome window
gravclone <url> --auth
```

The `--auth` flag attaches Playwright to the stealth Chrome over CDP (port 9222), so
asset capture and the test submit run inside the authenticated session.

## 2. Publish to the hosted demo hub

```bash
gravclone publish <domain> [--password X] [--slug Y]
```

- `<domain>` — same domain you cloned (e.g. `delphi.ai`)
- `--password` — optional cookie-gated password
- `--slug`    — optional URL slug (defaults to the domain's first label)

The command:
1. Rebuilds the zip with hub-appropriate rewrites (`/api/chat` → `./api/chat`, strips
   `server.py`/capture artifacts).
2. POSTs to the hub at `$(gravclone config).hub_url` with the shared bearer token.
3. Prints the public URL (`<hub>/<slug>/`).

Do NOT provision new AWS infra per demo. One EC2 hub hosts every clone; it lives in
`us-east-2` (see the tag `Project=gravclone`). Only re-provision if the hub is gone.

## 3. Config

Hub URL and publish token live in `~/.config/gravclone/config.json`:

```json
{
  "gravity_publisher_key": "...",
  "hub_url":   "https://demos.trygravity.ai",
  "hub_token": "..."
}
```

If `hub_url` or `hub_token` are missing, `publish` exits with instructions.

## 4. Hub location (reference only)

- Instance: `i-08dbd336bca5bb393`, `t3.micro`, `us-east-1` (sits with the rest of Gravity's infra)
- Public IP: `100.53.234.246`
- SSH: `ssh -i ~/.ssh/gravclone-hub.pem ubuntu@100.53.234.246`
- Service: `systemctl status gravclone-hub` (code under `/opt/gravclone/`)
- Domain: `demos.trygravity.ai` (A record → 18.189.28.119). Caddy terminates HTTPS via Let's Encrypt.
- Clone storage: `/srv/gravclones/<slug>/`

Code for the hub itself: `~/Development/Gravity/gravclone/hub/`. Re-deploy with:

```bash
cd ~/Development/Gravity/gravclone/hub
GRAVCLONE_HUB_TOKEN=<existing token from config> \
GRAVITY_PUBLISHER_KEY=<publisher key> \
  ./deploy.sh 100.53.234.246 --domain demos.trygravity.ai
```

## 5. Custom (per-clone native) ad variants

Every clone ships with the 23 `@gravity-ai/react` SDK variants via the bottom-right picker.
To add **custom variants hand-tuned to this specific site's look**, drop a
`custom-variants.js` file in the clone dir. `gravclone publish` includes it automatically.

Shape:

```js
window.__GC_CUSTOM_VARIANTS = {
  'name-shown-in-picker': {
    label: 'human-readable label',
    fullBleed: true,          // true → renders INSIDE the AI bubble (edge-to-edge footer)
                              // false → renders BELOW the bubble (normal slot)
    render(slot, ad, ctx) {
      // ad: { brandName, title, adText, cta, clickUrl, favicon, impUrl }
      // ctx: { theme, primaryColor }
      slot.innerHTML = `<div>...your HTML...</div>`;
    },
  },
};
```

The clone's chat script needs two changes to support this (already in the Delphi clone —
copy the pattern from `~/.gravclone/clones/delphi.ai/index.html`):

- Two slots per AI message: `.grav-ad-slot` (outside bubble) + `.grav-ad-inside` (inside).
- `injectAdInto(ad, row)` dispatcher picks the right slot + uses custom render if registered.

Delphi's 4 customs (good reference):
- `native-footer` (fullBleed) — full-width footer inside the AI bubble
- `citation` — quiet italic "recommended: X" below bubble
- `suggestion-chip` — pill mimicking Delphi's own suggested-prompt UI
- `matt-recommends` — an additional Matt Ryder bubble styled as his message

Rule of thumb: 3-5 customs per clone, matched to that site's palette + typography.

## 6. What NOT to do

- Do not bake the Gravity publisher key into zips distributed via `gravclone publish` —
  the hub calls `server.trygravity.ai` server-side with its own key.
- Do not launch new EC2 instances to host demos. Use the existing hub.
- Do not edit `server.py` in a published clone directory — the hub ignores it.
