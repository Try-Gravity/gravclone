# Architecture

gravclone is a single-file Node.js CLI that orchestrates Claude Code to clone publisher websites. The cloning happens in 5 phases.

## Overview

```
gravclone runable.com
    │
    ├─ Phase 1: Deep asset capture (Playwright)
    ├─ Phase 2: HTML/CSS rewriting (local paths)
    ├─ Phase 3: Flask server + Gravity API integration
    ├─ Phase 4: Chat shell injection + ad rendering
    └─ Phase 5: End-to-end Playwright test
```

## Phase 1: Deep asset capture

A Playwright script (`capture.py`) loads the target site and intercepts every network response — CSS chunks, fonts, icons, images, SVGs. Each asset is saved locally under `assets/` with a sanitized filename. The rendered HTML is saved as `page-raw.html` and a URL-to-local-path mapping is saved as `asset-map.json`.

Screenshots are taken at each stage for reference.

## Phase 2: HTML/CSS rewriting

Every URL in the captured HTML is replaced with its local path using the asset map. CSS files are also rewritten to fix relative `url()` references. The result is `index.html` — a fully self-contained page that loads from localhost.

## Phase 3: Flask server

A Python Flask server (`server.py`) is generated with two responsibilities:

1. **Static file serving** — serves `index.html` and all assets
2. **`/api/chat` endpoint** — calls two APIs in parallel:
   - [Pollinations.ai](https://pollinations.ai) for AI responses (free, no key needed)
   - [Gravity Ad API](https://server.trygravity.ai) for contextual ads

The Gravity favicon (`grav-favicon.png`) is downloaded from `trygravity.ai/favicon.png` and served locally because the `.ico` URL returns HTML.

### Fallback ad

When the Gravity API returns no ads (204), the server returns a test ad with correct SDK field names:

```python
{
    'brandName': 'Gravity',
    'title':     'Native Ads for AI Interfaces',
    'adText':    'Context-aware advertising built for AI-native products.',
    'cta':       'Learn more',
    'clickUrl':  'https://trygravity.ai',
    'favicon':   'http://localhost:PORT/grav-favicon.png',
}
```

## Phase 4: Chat shell injection (the Morph Pattern)

This is the core of gravclone. When a user submits a query from the homepage input:

### Site type detection

The agent classifies the site from screenshots:

| Type | Description | Approach |
|------|-------------|----------|
| **Type A** | Chat/AI homepage (ChatGPT, Manus, Runable, Rork) | Morph Pattern |
| **Type B** | Inline search/results (Perplexity logged-in) | Fetch intercept |
| **Type C** | Multi-step / form-based | Custom panel |

### The Morph Pattern (Type A)

Most AI tools have a marketing homepage with a centered prompt input that redirects to login. The Morph Pattern:

1. Intercepts the submit event (Enter key + click on send button)
2. Blocks React SPA navigation (`history.pushState` / `replaceState`)
3. Creates a full-screen chat shell (`position:fixed; inset:0`) that replaces the homepage
4. The shell has:
   - Top bar with site logo + "New chat" button
   - Scrollable message thread (user bubbles right, AI responses left)
   - Animated loading dots while waiting for the response
   - Input bar at the bottom matching the site's original input style
5. After the AI responds, renders the Gravity ad below the response
6. "New chat" removes the shell and restores the homepage

### For complex Next.js apps that crash

If the site's JavaScript crashes locally ("Application error"), the agent builds a clean static HTML replica from the captured screenshot instead of fighting the framework. This always works better.

### Ad rendering

Ads are rendered using the official [`@gravity-ai/react`](https://www.npmjs.com/package/@gravity-ai/react) SDK, loaded at runtime from esm.sh:

```javascript
const v = '18.3.1';
const [React, { createRoot }, { GravityAd }] = await Promise.all([
  import(`https://esm.sh/react@${v}`),
  import(`https://esm.sh/react-dom@${v}/client`),
  import(`https://esm.sh/@gravity-ai/react@1.1.6?deps=react@${v},react-dom@${v}`),
]);
```

All three imports must pin the same React version to avoid the "multiple React instances" crash.

### Variant picker

Every clone includes a floating picker (bottom-right) that re-renders the ad slot with a different variant on click. The ad data is stored in `data-grav-ad-data` attributes on each slot for re-rendering.

### Avatar handling

The AI avatar in the chat thread uses the site's actual favicon via an `<img>` tag:

```html
<img src="https://DOMAIN/favicon.ico" width="18" height="18"
     style="object-fit:contain;border-radius:3px;"
     onerror="this.style.display='none'">
```

Partial SVG reconstruction of site logos is explicitly avoided — it always looks broken.

## Phase 5: End-to-end test

A Playwright script submits a test query and takes a screenshot. The agent verifies:

1. The page morphed into a chat interface
2. The AI response rendered
3. The Gravity ad appeared with the favicon
4. The variant picker is visible

If anything fails, the agent fixes the code and retries.

## Key technical decisions

| Decision | Rationale |
|----------|-----------|
| Pollinations.ai over OpenRouter | Free, no API key — zips work for anyone |
| esm.sh over bundling | No build step, SDK loaded at runtime |
| React 18.3.1 pin | Avoids multi-instance crash with esm.sh |
| Static HTML fallback for Next.js | Fighting hydration errors is a losing battle |
| Google Fonts favicon service | `google.com/s2/favicons` is more reliable than `.ico` files |
| Local `grav-favicon.png` | trygravity.ai's favicon.ico returns HTML, not an image |
| `display:block` on all ad slots | Makes inline variants (text-link, hyperlink) visible in standalone placement |
