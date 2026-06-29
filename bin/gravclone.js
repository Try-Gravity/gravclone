#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";

const CONFIG_DIR  = path.join(os.homedir(), ".config", "gravclone");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const CLONES_DIR  = path.join(os.homedir(), ".gravclone", "clones");

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch { return {}; }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function ensureConfig() {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let changed = false;

  if (!cfg.gravity_publisher_key) {
    console.log("\n🔑  Gravity publisher key not set.");
    cfg.gravity_publisher_key = (await ask(rl, "   Enter your Gravity publisher key: ")).trim();
    changed = true;
  }

  rl.close();

  if (changed) {
    saveConfig(cfg);
    console.log(`\n✓  Config saved to ${CONFIG_FILE}\n`);
  }

  return cfg;
}

async function cmdSetup() {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\n── gravclone setup ──────────────────────────────");

  const gHint = cfg.gravity_publisher_key
    ? ` [${cfg.gravity_publisher_key.slice(0,8)}...${cfg.gravity_publisher_key.slice(-4)}]` : "";
  const gVal = (await ask(rl, `Gravity publisher key${gHint}: `)).trim();
  if (gVal) cfg.gravity_publisher_key = gVal;

  const oVal = (await ask(rl, `OpenRouter API key${oHint}: `)).trim();

  rl.close();
  saveConfig(cfg);
  console.log(`\n✓  Saved to ${CONFIG_FILE}\n`);
}

// ── List ──────────────────────────────────────────────────────────────────────

function cmdList() {
  if (!fs.existsSync(CLONES_DIR)) { console.log("No clones yet."); return; }
  const dirs = fs.readdirSync(CLONES_DIR).filter(d =>
    fs.statSync(path.join(CLONES_DIR, d)).isDirectory()
  );
  if (!dirs.length) { console.log("No clones yet."); return; }
  console.log("\n── Clones ───────────────────────────────────────");
  for (const d of dirs) {
    const hasServer = fs.existsSync(path.join(CLONES_DIR, d, "server.py"));
    const hasIndex  = fs.existsSync(path.join(CLONES_DIR, d, "index.html"));
    console.log(`  ${hasServer && hasIndex ? "✓" : "~"}  ${d}`);
  }
  console.log();
}

// ── Chrome (debug instance for --auth mode) ──────────────────────────────────

const CDP_PORT        = 9222;
const CHROME_PROFILE  = path.join(os.homedir(), ".gravclone", "chrome-profile");
const CHROME_BIN      = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const USER_CHROME_DIR = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");

function isDebugChromeRunning() {
  const r = spawnSync("curl", ["-s", "-m", "1", `http://localhost:${CDP_PORT}/json/version`], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("webSocketDebuggerUrl");
}

// Clone the user's real Chrome profile (cookies, history, extensions, fingerprint state)
// into the debug user-data-dir. Skips caches and session files so Chrome starts clean
// but bot-detectors see a fully aged profile. Preserves decryptability since it's the
// same OS user on the same machine (Keychain key is identical).
function syncUserProfile({ force = false } = {}) {
  const srcDefault = path.join(USER_CHROME_DIR, "Default");
  if (!fs.existsSync(srcDefault)) {
    console.error(`\n✗  Couldn't find your Chrome profile at ${srcDefault}`);
    console.error(`   Have you ever launched Chrome on this Mac?\n`);
    process.exit(1);
  }
  const dstDefault = path.join(CHROME_PROFILE, "Default");
  const marker     = path.join(CHROME_PROFILE, ".synced");
  if (fs.existsSync(marker) && !force) {
    console.log(`✓  Profile already cloned at ${CHROME_PROFILE}`);
    console.log(`   (run 'gravclone chrome --refresh' to re-sync cookies/history)`);
    return;
  }
  // No marker = either first run, or a previous fresh-profile dir from the old gravclone.
  // Nuke it so we start from a clean clone of the user's real profile.
  if (fs.existsSync(CHROME_PROFILE)) {
    fs.rmSync(CHROME_PROFILE, { recursive: true, force: true });
  }
  fs.mkdirSync(dstDefault, { recursive: true });
  console.log(`\n📋  Cloning your Chrome profile into the debug dir (may take ~30s)...`);
  const excludes = [
    "Cache", "Code Cache", "GPUCache", "DawnCache",
    "DawnGraphiteCache", "DawnWebGPUCache", "Media Cache",
    "Application Cache", "File System", "Service Worker/CacheStorage",
    "Service Worker/ScriptCache", "Crashpad", "ShaderCache",
    "Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs",
    "LOCK", "SingletonCookie", "SingletonLock", "SingletonSocket",
  ].flatMap(e => ["--exclude", e]);
  const r = spawnSync("rsync", [
    "-a",
    ...excludes,
    srcDefault + "/",
    dstDefault + "/",
  ], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("\n✗  rsync failed.\n");
    process.exit(1);
  }
  // Local State lives at user-data-dir root and holds the encrypted master key
  const lsSrc = path.join(USER_CHROME_DIR, "Local State");
  const lsDst = path.join(CHROME_PROFILE, "Local State");
  if (fs.existsSync(lsSrc)) fs.copyFileSync(lsSrc, lsDst);
  fs.writeFileSync(marker, new Date().toISOString());
  console.log(`✓  Profile cloned.`);
}

function cmdChrome(opts = {}) {
  if (!fs.existsSync(CHROME_BIN)) {
    console.error(`\nChrome not found at ${CHROME_BIN}\n`);
    process.exit(1);
  }
  if (isDebugChromeRunning()) {
    console.log(`\n✓  Debug Chrome already running on port ${CDP_PORT}`);
    console.log(`   Profile: ${CHROME_PROFILE}\n`);
    if (opts.refresh) {
      console.log(`   Quit that Chrome first before --refresh.\n`);
    }
    return;
  }
  syncUserProfile({ force: !!opts.refresh });
  console.log(`\n🌐  Launching Chrome with your cloned profile (stealth — uses your real fingerprint)`);
  console.log(`    Profile:  ${CHROME_PROFILE}`);
  console.log(`    CDP port: ${CDP_PORT}`);
  console.log(`\n    Your main Chrome is untouched. This one has your cookies/history/extensions.`);
  console.log(`    Log into the site(s) you want to clone, then:  gravclone <url> --auth\n`);
  // Force a visible window on macOS by passing a URL + --new-window.
  // Without these, Chrome sometimes launches as a background process with no UI.
  const child = spawn(CHROME_BIN, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=ChromeWhatsNewUI,GlobalMediaControls",
    "--restore-last-session=false",
    "--new-window",
    "about:blank",
  ], { stdio: "ignore", detached: true });
  child.unref();
  console.log(`    Chrome launched (pid ${child.pid}).\n`);
}

// ── Clone ─────────────────────────────────────────────────────────────────────

function buildPrompt({ url, port, outputDir, domain, notes, gravityKey, auth }) {
  const notesLine = notes.trim() ? `Special instructions: ${notes}` : "";

  const launchBlock = auth
    ? `        # AUTH MODE — attach to the user's already-running debug Chrome via CDP.
        # This Chrome is logged into the target site, so we get the REAL authed UI.
        browser = p.chromium.connect_over_cdp('http://localhost:${CDP_PORT}')
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()`
    : `        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={'width': 1440, 'height': 900},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )`;

  const closeBlock = auth
    ? `        page.close()
        # AUTH MODE — do NOT browser.close(); that would terminate the user's Chrome session.`
    : `        browser.close()`;

  const authHeader = auth
    ? `

## AUTH MODE IS ACTIVE

This capture attaches to the user's logged-in Chrome over CDP (port ${CDP_PORT}).
The site at ${url} should render as an authenticated user. Your job is to capture
the REAL app UI (chat thread, sidebar, composer, etc.) — not a logged-out marketing page.

Rules:
- Do NOT treat a login wall as the main page. If you see one, the session expired —
  stop and report it.
- You may navigate into sub-routes the user has access to (e.g. a specific chat
  thread) if the URL resolves under the same origin and the page renders.
- NEVER call browser.close() — it would kill the user's Chrome. Use page.close().
- The "send a test query" step in capture.py will actually post to the real app as
  the user. Use a benign query ("hello, testing a clone") and keep it to ONE submit.
`
    : "";

  return `Linear ticket: GRV-951 (Publisher website cloner — internal ad placement testing tool)

Clone this publisher website, make it semi-functional with a real AI backend, and inject live Gravity ads.

URL: ${url}
Output directory: ${outputDir}
Local server port: ${port}
${notesLine}
${authHeader}
---

## Phase 1: Deep asset capture

Write and run ${outputDir}/capture.py. This script intercepts EVERY network request
the browser makes and saves each asset locally — CSS chunks, fonts, icons, images, SVGs, everything.
This is how we get a high-fidelity clone instead of a cheap imitation.

    from playwright.sync_api import sync_playwright
    import os, re, time, hashlib
    from urllib.parse import urlparse, urljoin
    from pathlib import Path

    OUTPUT = Path('${outputDir}')
    ASSETS = OUTPUT / 'assets'
    ASSETS.mkdir(exist_ok=True)
    captured = {}  # url -> local path

    def local_path_for(url):
        parsed = urlparse(url)
        # Build a clean local path from the URL
        ext = Path(parsed.path).suffix or '.bin'
        safe = re.sub(r'[^a-zA-Z0-9._-]', '_', parsed.netloc + parsed.path)[:120]
        return ASSETS / (safe + ('' if safe.endswith(ext) else ext))

    with sync_playwright() as p:
${launchBlock}

        # Intercept all responses and save them locally
        def handle_response(response):
            url = response.url
            if any(skip in url for skip in ['analytics', 'tracking', 'telemetry', 'beacon', 'hotjar', 'segment', 'sentry']):
                return
            ct = response.headers.get('content-type', '')
            if not any(t in ct for t in ['css', 'javascript', 'font', 'image', 'svg', 'icon', 'woff', 'ttf', 'otf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico']):
                return
            try:
                body = response.body()
                lp = local_path_for(url)
                lp.parent.mkdir(parents=True, exist_ok=True)
                lp.write_bytes(body)
                captured[url] = str(lp.relative_to(OUTPUT))
            except:
                pass

        page = ctx.new_page()
        page.on('response', handle_response)

        page.goto('${url}', wait_until='networkidle', timeout=45000)
        time.sleep(2)
        page.screenshot(path=str(OUTPUT / '01-homepage.png'), full_page=True)

        # Detect login walls
        page_text = page.inner_text('body').lower()
        has_login_wall = any(x in page_text for x in ['sign in', 'log in', 'create account', 'sign up'])
        has_input = page.locator('input[type=search], input[name=q], textarea, div[contenteditable=true]').count() > 0
        print(f'login_wall={has_login_wall} has_input={has_input}')

        if has_input:
            try:
                inp = page.locator(
                    'input[type=search], input[name=q], input[name=query], '
                    'input[placeholder*=search i], textarea[placeholder*=search i], '
                    'input[placeholder*=ask i], textarea[placeholder*=ask i], '
                    'div[contenteditable=true]'
                ).first
                inp.fill('best credit cards 2024')
                inp.press('Enter')
                page.wait_for_load_state('networkidle', timeout=15000)
                time.sleep(3)
                page.screenshot(path=str(OUTPUT / '02-after-query.png'), full_page=True)
                inp2 = page.locator('input[type=search], input[name=q], textarea, div[contenteditable=true]').first
                inp2.fill('travel insurance comparison')
                inp2.press('Enter')
                page.wait_for_load_state('networkidle', timeout=15000)
                time.sleep(3)
                page.screenshot(path=str(OUTPUT / '03-after-query2.png'), full_page=True)
            except Exception as e:
                print(f'interaction failed: {e}')
        elif has_login_wall:
            for selector in ['text=guest', 'text=without signing', 'text=try it', 'text=skip', 'text=continue without']:
                try:
                    btn = page.locator(selector).first
                    if btn.is_visible():
                        btn.click()
                        page.wait_for_load_state('networkidle', timeout=10000)
                        time.sleep(2)
                        page.screenshot(path=str(OUTPUT / '02-after-guest.png'), full_page=True)
                        break
                except:
                    pass

        # Save the rendered HTML
        html = page.content()
        with open(OUTPUT / 'page-raw.html', 'w') as f:
            f.write(html)

        # Save the URL->localpath mapping
        import json
        with open(OUTPUT / 'asset-map.json', 'w') as f:
            json.dump(captured, f, indent=2)

        print(f'Captured {len(captured)} assets')
        print('asset types:', set(Path(v).suffix for v in captured.values()))
${closeBlock}

Run: python3 ${outputDir}/capture.py

---

## Phase 2: Rewrite HTML to use local assets

Read page-raw.html and rewrite EVERY asset URL to point to the local file:

    import json, re
    from pathlib import Path
    from urllib.parse import urlparse

    OUTPUT = Path('${outputDir}')
    asset_map = json.loads((OUTPUT / 'asset-map.json').read_text())
    html = (OUTPUT / 'page-raw.html').read_text()

    # Replace every captured URL with its local path
    for remote_url, local_path in sorted(asset_map.items(), key=lambda x: -len(x[0])):
        html = html.replace(remote_url, local_path)

    # Fix remaining relative paths (leading slash) to point to live CDN as fallback
    html = re.sub(r'((?:href|src|action)=["\\'\\'])(/(?!/["\\'\\']))', r'\\1https://${domain}\\2', html)

    with open(OUTPUT / 'index.html', 'w') as f:
        f.write(html)
    print('Rewrote HTML with local asset paths')

Also rewrite URLs inside any downloaded CSS files (they may reference fonts/images with relative paths):

    for css_file in (OUTPUT / 'assets').rglob('*.css'):
        css = css_file.read_text(errors='replace')
        for remote_url, local_path in asset_map.items():
            css = css.replace(remote_url, '../' + local_path)
        # Fix relative url() in CSS
        css = re.sub(r'url\\(["\\'\\']?(/(?!/))([^"\\'\\')]+)["\\'\\']?\\)',
                     lambda m: f'url(https://${domain}/{m.group(2)})', css)
        css_file.write_text(css)
    print('Rewrote CSS asset paths')

---

## Phase 2: Fix the HTML

    import re
    html = open('${outputDir}/page-with-ads.html').read()
    html = re.sub(r'((?:href|src|action)=["\\'\\'])(/(?!/["\\'\\']))', r'\\1https://${domain}\\2', html)
    with open('${outputDir}/index.html', 'w') as f:
        f.write(html)

---

## Phase 3: Build server.py

First, download the Gravity favicon so it can be served locally (trygravity.ai/favicon.ico
returns HTML, not an image — always serve it from our own server):

    import urllib.request
    urllib.request.urlretrieve('https://trygravity.ai/favicon.png?v=2', '${outputDir}/grav-favicon.png')

Create ${outputDir}/server.py:

    import concurrent.futures, uuid, os
    from flask import Flask, request, jsonify, send_from_directory
    import requests as req

    app = Flask(__name__)
    CLONE_DIR      = os.path.dirname(os.path.abspath(__file__))
    GRAVITY_KEY    = "${gravityKey}"
    PORT           = ${port}

    @app.route('/', defaults={'path': 'index.html'})
    @app.route('/<path:path>')
    def static_files(path):
        import os
        full = os.path.join(CLONE_DIR, path)
        if os.path.isfile(full):
            return send_from_directory(CLONE_DIR, path)
        if path.startswith('assets/'):
            filename = path[len('assets/'):]
            prefixed = os.path.join(CLONE_DIR, 'assets', f'${domain}_assets_{filename}')
            if os.path.isfile(prefixed):
                return send_from_directory(os.path.join(CLONE_DIR, 'assets'), f'${domain}_assets_{filename}')
        return send_from_directory(CLONE_DIR, path)

    @app.post('/api/chat')
    def chat():
        data       = request.json or {}
        messages   = data.get('messages', [])
        session_id = data.get('sessionId', str(uuid.uuid4()))
        client_ip  = request.headers.get('X-Forwarded-For', request.remote_addr)

        def call_openrouter():
            r = req.post(
                'https://text.pollinations.ai/openai',
                headers={'Content-Type': 'application/json'},
                json={'model': 'openai', 'messages': messages},
                timeout=30,
            )
            return r.json()['choices'][0]['message']['content']

        def call_gravity():
            try:
                r = req.post(
                    'https://server.trygravity.ai/api/v1/ad',
                    headers={'Authorization': f'Bearer {GRAVITY_KEY}', 'Content-Type': 'application/json'},
                    json={
                        'messages':   [{k: m[k] for k in ('role','content')} for m in messages[-2:]],
                        'sessionId':  session_id,
                        'placements': [{'placement': 'below_response', 'placement_id': 'main'}],
                        'user':       {'id': 'anonymous'},
                        'device':     {'ip': client_ip},
                        'relevancy':  0.2,
                        'testAd':     False,
                    },
                    timeout=5,
                )
                if r.ok and r.content:
                    d = r.json()
                    if isinstance(d, list) and d:
                        return d
                    if isinstance(d, dict) and d.get('brandName'):
                        return [d]
            except Exception:
                pass
            # Fallback — field names MUST match SDK: brandName, adText, title, cta, clickUrl, favicon
            # favicon: serve locally — trygravity.ai/favicon.ico returns HTML not an image
            last_user = next((m['content'] for m in reversed(messages) if m.get('role') == 'user'), '')
            return [{
                'brandName': 'Gravity',
                'title':     'Native Ads for AI Interfaces',
                'adText':    'Context-aware advertising built for AI-native products.',
                'cta':       'Learn more',
                'clickUrl':  'https://trygravity.ai',
                'favicon':   f'http://localhost:{PORT}/grav-favicon.png',
            }]

        with concurrent.futures.ThreadPoolExecutor() as ex:
            ai_f    = ex.submit(call_openrouter)
            ad_f    = ex.submit(call_gravity)
            ai_text = ai_f.result()
            ads     = ad_f.result()

        return jsonify({'response': ai_text, 'ads': ads})

    if __name__ == '__main__':
        app.run(port=PORT, debug=False)

Install deps if needed: pip3 install flask requests

**IMPORTANT**: After any change to server.py, you must kill and restart the server for
changes to take effect. Python Flask does not hot-reload in production mode.

---

## Phase 4: Integrate Gravity AI chat — make it feel completely native

Your goal: when a user types into the site's main input and submits, the AI response and
Gravity ad must appear as if they are part of the site itself. A visitor should not be able
to tell that anything was injected.

**NEVER use position:fixed overlays or bottom panels bolted onto the page.**

### Step 4a: Identify the site type from your screenshots

Look at the screenshots (${outputDir}/02-after-query.png etc.) and classify the site:

**Type A — Chat/AI homepage** (most common for AI tools):
The site has a centered prompt input on a marketing homepage. Submitting normally
redirects to a login wall or a separate /chat route. Examples: ChatGPT, Claude, Perplexity,
Runable, Genspark, Manus, Bolt, etc.
→ Use the MORPH PATTERN (see below).

**Type B — Inline search/results** (search engines, research tools):
The site shows results on the same page below the input without navigating away.
Examples: Perplexity (logged in), search engines, answer engines.
→ Intercept the fetch call to the results API, inject our response into the results container
  the site's own renderer creates, and place the Gravity ad directly below the first result.

**Type C — Multi-step / form-based**:
The site takes input across multiple steps or has no clear single AI response area.
→ Wire the submit button to call /api/chat, render the response in a panel styled to match
  the site's content area, and place the ad below it.

---

### THE MORPH PATTERN (use for Type A sites)

When the user submits from the homepage input, the entire page transforms into a
full-screen chat interface that looks like the site's own chat product. No gaps, no dead
space, no bolted-on widgets. The visitor should feel like they logged in and got a response.

How it works:
1. Intercept the submit (keydown Enter + click on arrow/send button)
2. Block React SPA navigation: override history.pushState and history.replaceState to
   prevent redirects to login or /chat routes
3. Inject a <style> block and build a position:fixed; inset:0 chat shell that:
   - **Top bar**: site logo (copy the text/icon from the nav) + "New chat" button — match
     the site's nav font, size, border-bottom color
   - **Thread area**: flex:1, overflow-y:auto, max-width ~700px centered — user bubbles
     right-aligned with the site's background color and border-radius, AI responses
     left-aligned with an avatar matching the site's brand color
   - **Loading state**: animated bouncing dots (not a spinner) while waiting for response
   - **Input bar**: fixed to the bottom of the shell, styled to exactly match the site's
     original input box — same background, border, border-radius, font size, placeholder
     text, and send button
4. On submit from the chat input bar, call /api/chat, render the response in the thread,
   then render the Gravity ad (data.ads[0]) inline below the response
5. "New chat" button removes the shell and restores the original homepage

Style rules:
- Detect dark/light mode from <html class="dark"> and match it exactly
- Copy the site's font stack, primary color, border-radius from the existing CSS
- The Gravity ad should use the site's own card/border style — subtle, not orange-heavy
- Animated loading dots: 3 small circles, staggered bounce animation

---

### Step 4b: Update ${outputDir}/index.html

Read the current index.html. Edit it directly — add the <style> block and inject the
integration script just before </body>. Write code that fits this specific site's design.

Call /api/chat with: { messages: [{role, content}, ...], sessionId: SESSION_ID }
Show data.ads[0] as the Gravity ad. Fire ad.impUrl as an image pixel if present.

Update the file. Then run the Playwright test below. Look at the screenshot. If it's wrong,
update the file again and re-test. Keep iterating until the screenshot is indistinguishable
from the site's own chat interface.

### Step 4c: End-to-end test with Playwright — do NOT ship until this passes

    from playwright.sync_api import sync_playwright
    import time

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.goto('http://localhost:${port}', wait_until='networkidle', timeout=15000)
        time.sleep(2)
        try:
            inp = page.locator('div[contenteditable=true], textarea, input[type=text]').first
            inp.fill('what are the best credit cards in 2024')
            inp.press('Enter')
            time.sleep(15)  # wait for AI response
            # scroll to bottom of chat thread if it exists
            page.evaluate('try{document.querySelector(".grav-thread,.grav-thread-inner,[id*=thread]").scrollTop=99999}catch(e){}')
            time.sleep(1)
        except Exception as e:
            print('input error:', e)
        page.screenshot(path='${outputDir}/after-typing.png')
        browser.close()

Open ${outputDir}/after-typing.png and verify:
1. The page morphed into a full chat interface (not still showing the homepage)
2. The AI response is visible with proper formatting
3. The Gravity ad appears below the response with the Gravity favicon showing
4. The variant picker button is visible in the bottom-right corner
5. Nothing looks bolted on — it should look like the real site's chat product

If anything looks wrong — fix the code and re-run. Common issues to check:
- If page still shows homepage: submit interceptor not firing (check input selector)
- If ad favicon is empty: check favicon field in server.py fallback (must be localhost URL)
- If avatar looks like broken SVG fragments: replace with <img src="favicon"> instead
- If text-link/hyperlink variant shows only "Ad": normal — it's there, just tiny inline text

---

### Ad styling rules — non-negotiable

The Gravity ad must look premium and native. Follow these rules exactly:

**Layout**: Single horizontal row — logo · brand name + "Ad" badge · title · CTA pill.
No multi-line card stacks. No description body text taking up space. Tight padding (8-10px).

**Colors**:
- CTA button: detect the platform's own primary action color at runtime by sampling
  computed styles of existing buttons on the page. Skip whites, blacks, and grays
  (low saturation). Use the first colorful button background you find. Never invent
  a random color.
- Card background: near-white (#fafafa) on light, near-black (#111) on dark.
- Card border: 1px solid rgba(0,0,0,0.07) — barely visible.

**Use the official @gravity-ai/react SDK for rendering ads — do not hand-roll ad HTML.**

Load it at runtime via esm.sh (no build step needed). Pin all React packages to the same
version to avoid the "multiple React instances" crash:

    let _sdk = null;
    async function getSDK() {
      if (_sdk) return _sdk;
      const v = '18.3.1';
      const [React, { createRoot }, { GravityAd }] = await Promise.all([
        import(\`https://esm.sh/react@\${v}\`),
        import(\`https://esm.sh/react-dom@\${v}/client\`),
        import(\`https://esm.sh/@gravity-ai/react@1.1.6?deps=react@\${v},react-dom@\${v}\`),
      ]);
      _sdk = { React, createRoot, GravityAd };
      return _sdk;
    }

    async function injectAd(ad, slot) {
      if (!slot) return;
      // IMPORTANT: trust favicon from server — don't override if already set.
      // trygravity.ai/favicon.ico returns HTML not an image; server.py serves it locally.
      const sdkAd = {
        ...ad,
        favicon: ad.favicon || ad.faviconUrl
          || (ad.clickUrl ? \`https://www.google.com/s2/favicons?sz=32&domain=\${(()=>{try{return new URL(ad.clickUrl).hostname}catch{return ''}})()} \` : undefined),
      };
      // Make slot block-level so ALL variants (including inline text-link/hyperlink) are visible
      slot.style.display = 'block';
      slot.style.fontSize = '15px';
      slot.style.lineHeight = '1.6';
      // Tag for re-render by variant picker
      slot.dataset.gravAdSlot = '1';
      slot.dataset.gravAdData = JSON.stringify(ad);
      const { React, createRoot, GravityAd } = await getSDK();
      createRoot(slot).render(React.createElement(GravityAd, {
        ad: sdkAd,
        variant: AD_VARIANT,
        labelText: 'Ad',
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      }));
    }

Available variants (all work as standalone blocks):
  card | inline | minimal | bubble | contextual | native | footnote | quote |
  suggestion | accent | side-panel | labeled | spotlight | embed | split-action |
  pill | banner | divider | toolbar | tooltip | notification | hyperlink | text-link

Note: text-link and hyperlink are inline variants — they render as a blue linked line of
text. They work fine, but need the slot to have display:block and font-size set (done above).

Choose the default variant that best fits the site:
- Chat/conversation interfaces: 'suggestion' or 'inline'
- Content/article sites: 'native', 'contextual', or 'quote'
- Prominent placement: 'card', 'accent', or 'split-action'

**AI agent avatar** — CRITICAL rules:
- NEVER reconstruct the site's logo as SVG by copying partial path data. Partial SVGs
  look broken and damaged. Always use an img tag.
- Use: <img src="https://SITE_DOMAIN/favicon.ico" width="20" height="20"
       style="object-fit:contain;border-radius:3px;"
       onerror="this.style.display='none'">
- Or find the <link rel="icon"> href from the page's <head> and use that URL.
- Avatar circle: neutral background (#f0f0f0), not orange/gradient.

**If the site has a Next.js / complex SPA that crashes (shows "Application error"):**
Do NOT try to fix the Next.js crash. Instead:
1. Look at the captured 01-homepage.png screenshot
2. Build a clean static HTML replica of the homepage from scratch, matching the visual
   design pixel-for-pixel (font, colors, layout, nav, input box, pills)
3. Add the Gravity chat shell injection to that static page
This always works better than fighting Next.js hydration errors.

---

### Floating variant picker — include in EVERY clone

After the ad integration, inject this floating picker so anyone demoing the clone can
switch ad variants in real time without touching code. It must be present in every clone.

    const ALL_VARIANTS = [
      'inline','card','minimal','bubble','contextual','native','footnote','quote',
      'suggestion','accent','side-panel','labeled','spotlight','embed','split-action',
      'pill','banner','divider','toolbar','tooltip','notification','hyperlink','text-link',
    ];
    let AD_VARIANT = 'inline'; // change default to best fit for this site

    (function buildPicker() {
      const s = document.createElement('style');
      s.textContent = \`
        #grav-picker { position:fixed; bottom:20px; right:20px; z-index:99999; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
        #grav-picker-toggle { background:#111; color:#fff; border:none; border-radius:20px; padding:7px 14px; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:6px; box-shadow:0 2px 12px rgba(0,0,0,0.2); white-space:nowrap; }
        #grav-picker-toggle:hover { background:#333; }
        #grav-picker-panel { position:absolute; bottom:42px; right:0; background:#fff; border:1px solid rgba(0,0,0,0.1); border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,0.15); padding:8px; width:190px; display:none; flex-direction:column; gap:1px; max-height:420px; overflow-y:auto; }
        #grav-picker-panel.open { display:flex; }
        .grav-picker-item { padding:7px 10px; border-radius:7px; font-size:12px; cursor:pointer; color:#333; transition:background .1s; }
        .grav-picker-item:hover { background:#f5f5f5; }
        .grav-picker-item.active { background:#111; color:#fff; font-weight:600; }
        #grav-picker-label { font-size:10px; color:#999; padding:4px 10px 6px; text-transform:uppercase; letter-spacing:.5px; }
      \`;
      document.head.appendChild(s);

      const el = document.createElement('div');
      el.id = 'grav-picker';
      el.innerHTML = \`
        <div id="grav-picker-panel">
          <div id="grav-picker-label">Ad variant</div>
          \${ALL_VARIANTS.map(v => \`<div class="grav-picker-item\${v===AD_VARIANT?' active':''}" data-variant="\${v}">\${v}</div>\`).join('')}
        </div>
        <button id="grav-picker-toggle">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="4" height="4" rx="1" fill="currentColor"/><rect x="7" y="1" width="4" height="4" rx="1" fill="currentColor"/><rect x="1" y="7" width="4" height="4" rx="1" fill="currentColor"/><rect x="7" y="7" width="4" height="4" rx="1" fill="currentColor"/></svg>
          <span id="grav-picker-current">\${AD_VARIANT}</span>
        </button>
      \`;
      document.body.appendChild(el);

      const panel = document.getElementById('grav-picker-panel');
      document.getElementById('grav-picker-toggle').addEventListener('click', () => panel.classList.toggle('open'));
      document.addEventListener('click', e => { if (!el.contains(e.target)) panel.classList.remove('open'); });

      panel.addEventListener('click', async e => {
        const item = e.target.closest('.grav-picker-item');
        if (!item) return;
        AD_VARIANT = item.dataset.variant;
        document.getElementById('grav-picker-current').textContent = AD_VARIANT;
        panel.querySelectorAll('.grav-picker-item').forEach(i => i.classList.toggle('active', i.dataset.variant === AD_VARIANT));
        panel.classList.remove('open');
        // Re-render all existing ad slots
        for (const slot of document.querySelectorAll('[data-grav-ad-slot="1"]')) {
          const ad = JSON.parse(slot.dataset.gravAdData || '{}');
          slot.innerHTML = '';
          await injectAd(ad, slot);
        }
      });
    })();

When calling injectAd, tag the slot so the picker can find and re-render it:
    adSlot.dataset.gravAdSlot = '1';
    adSlot.dataset.gravAdData = JSON.stringify(ads[0]);
    injectAd(ads[0], adSlot);

---

## Phase 5: Start, test, screenshot

Kill port ${port}: fuser -k ${port}/tcp 2>/dev/null || true
Start: python3 ${outputDir}/server.py &
Wait 2s, then:

    curl -s -X POST http://localhost:${port}/api/chat \\
      -H "Content-Type: application/json" \\
      -d '{"messages":[{"role":"user","content":"what are the best solar panels?"}],"sessionId":"test-123"}' \\
    | python3 -m json.tool

Screenshot with Playwright → ${outputDir}/final.png

Report: local URL, AI model, ad returned (brand/headline/cta), how input wiring works, any quirks.
`;
}

function buildImagePrompt({ imagePath, port, outputDir, name, notes, gravityKey }) {
  const notesLine = notes.trim() ? `Special instructions: ${notes}` : "";

  return `Clone a publisher's UI from a screenshot image. The result must be PIXEL PERFECT —
visually indistinguishable from the original image. This is for demoing Gravity ad placements
to publishers so the fidelity must be flawless.

Source image: ${imagePath}
Output directory: ${outputDir}
Local server port: ${port}
Clone name: ${name}
${notesLine}

---

## Phase 1: Analyze the source image in extreme detail

Read the source image at ${imagePath}. Before writing a single line of code, study it like a
forensic analyst. Document EVERY detail:

1. **Layout grid**: How many columns? Is there a sidebar? Header height? Footer? Content max-width?
   Estimate actual pixel values for widths, heights, margins, padding.
2. **Color palette**: Extract EXACT hex colors — background, foreground text, muted text,
   primary accent, secondary accent, borders, card backgrounds, hover states. Be precise:
   #0f0f23 is NOT the same as #1a1a2e.
3. **Typography**: Font family (Inter, SF Pro, system-ui?), every font-size in use (headings,
   body, captions, nav), font-weights (400, 500, 600, 700), line-heights, letter-spacing.
4. **Components inventory**: List EVERY component — nav bar, logo, buttons (each variant),
   inputs, cards, badges/pills, avatars, icons, dividers, dropdowns, tabs.
   For each: exact size, color, border-radius, padding, shadow.
5. **Spacing system**: What's the base spacing unit? 4px grid? 8px? Document gaps between
   every major section and between items within sections.
6. **Dark/light mode**: Which is it? What are the exact surface colors at each elevation level?
7. **Iconography**: What icon set? Lucide? Heroicons? Custom SVGs? List each icon and its context.
8. **Decorative details**: Gradients, patterns, glows, blurs, subtle borders, opacity values.

Save this analysis to ${outputDir}/analysis.md — you'll reference it constantly.

---

## Phase 2: Build the pixel-perfect HTML replica

Create ${outputDir}/index.html — a single self-contained HTML file that replicates the
screenshot with zero visual deviation.

### Tech stack (CDN only, no build step):

    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            // Add the exact colors from your analysis here
          }
        }
      }
    </script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>

### Construction rules — NON-NEGOTIABLE:

**Colors**: Use the EXACT hex values from your analysis. Don't approximate. Don't use
Tailwind's default palette if the site uses custom colors. Configure them in tailwind.config.

**Spacing**: Match EXACTLY. If the gap between cards looks like 24px, use gap-6. If it's
closer to 20px, use gap-5. Zoom into the image. Don't guess — analyze.

**Border radius**: Most shadcn sites use rounded-xl (12px) for cards, rounded-lg (8px) for
buttons, rounded-md (6px) for inputs. Match what you see exactly.

**Typography**: Set font-family to Inter. Match every font-size, weight, and color precisely.
Headings are usually font-semibold or font-bold. Body is font-normal. Captions are text-sm
text-muted-foreground.

**Shadows**: Most modern UIs use very subtle shadows — shadow-sm or shadow-[0_1px_3px_rgba(0,0,0,0.05)].
Match the exact shadow intensity.

**Icons**: Use Lucide icons where possible. Initialize after DOM load:
    <script>document.addEventListener('DOMContentLoaded', () => lucide.createIcons());</script>
    Use: <i data-lucide="search" class="w-5 h-5"></i>

**Images/avatars**: Use placeholder boxes with matching background colors and dimensions.
Or use https://placehold.co/WxH/COLOR/COLOR for realistic placeholders.

**The page must look identical at 1440x900 viewport.** This is the reference resolution.

### shadcn pattern reference (most AI/SaaS tools use these):

Cards: rounded-xl border border-border/50 bg-card shadow-sm
Buttons (primary): bg-primary text-primary-foreground rounded-lg px-4 py-2.5 font-medium
Buttons (outline): border border-input bg-background rounded-lg px-4 py-2.5 font-medium
Inputs: rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground
Badges: rounded-full px-2.5 py-0.5 text-xs font-medium
Avatar circles: rounded-full bg-muted w-8 h-8

---

## Phase 3: Build server.py

First, download the Gravity favicon:

    import urllib.request
    urllib.request.urlretrieve('https://trygravity.ai/favicon.png?v=2', '${outputDir}/grav-favicon.png')

Create ${outputDir}/server.py:

    import concurrent.futures, uuid, os
    from flask import Flask, request, jsonify, send_from_directory
    import requests as req

    app = Flask(__name__)
    CLONE_DIR      = os.path.dirname(os.path.abspath(__file__))
    GRAVITY_KEY    = "${gravityKey}"
    PORT           = ${port}

    @app.route('/', defaults={'path': 'index.html'})
    @app.route('/<path:path>')
    def static_files(path):
        return send_from_directory(CLONE_DIR, path)

    @app.post('/api/chat')
    def chat():
        data       = request.json or {}
        messages   = data.get('messages', [])
        session_id = data.get('sessionId', str(uuid.uuid4()))
        client_ip  = request.headers.get('X-Forwarded-For', request.remote_addr)

        def call_ai():
            r = req.post(
                'https://text.pollinations.ai/openai',
                headers={'Content-Type': 'application/json'},
                json={'model': 'openai', 'messages': messages},
                timeout=30,
            )
            return r.json()['choices'][0]['message']['content']

        def call_gravity():
            try:
                r = req.post(
                    'https://server.trygravity.ai/api/v1/ad',
                    headers={'Authorization': f'Bearer {GRAVITY_KEY}', 'Content-Type': 'application/json'},
                    json={
                        'messages':   [{k: m[k] for k in ('role','content')} for m in messages[-2:]],
                        'sessionId':  session_id,
                        'placements': [{'placement': 'below_response', 'placement_id': 'main'}],
                        'user':       {'id': 'anonymous'},
                        'device':     {'ip': client_ip},
                        'relevancy':  0.2,
                        'testAd':     False,
                    },
                    timeout=5,
                )
                if r.ok and r.content:
                    d = r.json()
                    if isinstance(d, list) and d:
                        return d
                    if isinstance(d, dict) and d.get('brandName'):
                        return [d]
            except Exception:
                pass
            return [{
                'brandName': 'Gravity',
                'title':     'Native Ads for AI Interfaces',
                'adText':    'Context-aware advertising built for AI-native products.',
                'cta':       'Learn more',
                'clickUrl':  'https://trygravity.ai',
                'favicon':   f'http://localhost:{PORT}/grav-favicon.png',
            }]

        with concurrent.futures.ThreadPoolExecutor() as ex:
            ai_f    = ex.submit(call_ai)
            ad_f    = ex.submit(call_gravity)
            ai_text = ai_f.result()
            ads     = ad_f.result()

        return jsonify({'response': ai_text, 'ads': ads})

    if __name__ == '__main__':
        app.run(port=PORT, debug=False)

Install deps if needed: pip3 install flask requests

---

## Phase 4: VISUAL COMPARISON LOOP — this is the entire point

This is the most critical phase. You will iterate relentlessly until the clone is
INDISTINGUISHABLE from the source image. "Close enough" does not exist.

### Start the server:

    lsof -ti :${port} | xargs kill -9 2>/dev/null || true
    sleep 0.5
    python3 ${outputDir}/server.py &
    sleep 2

### THE LOOP — minimum 3 iterations, keep going until PERFECT:

#### Step 1: Screenshot your build

Write and run:

    from playwright.sync_api import sync_playwright
    import time
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.goto('http://localhost:${port}', wait_until='networkidle', timeout=15000)
        time.sleep(2)
        page.screenshot(path='${outputDir}/compare-iter-ITERATION.png', full_page=True)
        browser.close()

Replace ITERATION with the current loop count (1, 2, 3, ...).

#### Step 2: Compare with BRUTAL honesty

Read BOTH images:
- Original:   ${imagePath}
- Your build: ${outputDir}/compare-iter-ITERATION.png

Study them side by side. Compare EVERY single detail:

    [ ] Overall layout structure matches (columns, rows, grid)
    [ ] Header/nav matches (height, background, items, spacing)
    [ ] Background colors are IDENTICAL (not "close" — identical)
    [ ] Text colors are IDENTICAL at every level (headings, body, muted, links)
    [ ] Font sizes match exactly for every text element
    [ ] Font weights match exactly
    [ ] Border radius matches on EVERY element (cards, buttons, inputs, avatars)
    [ ] Box shadows match (intensity, spread, color)
    [ ] Button styles match (background, text color, padding, border)
    [ ] Input/textarea styles match (border, background, placeholder color, padding)
    [ ] Card/container styles match (background, border, padding, spacing)
    [ ] Badge/pill styles match (color, padding, radius)
    [ ] Icon positions, sizes, and styles match
    [ ] Spacing between ALL elements matches (margins, padding, gaps)
    [ ] Decorative elements match (gradients, dividers, patterns, glows)
    [ ] Nothing is misaligned, overflowing, clipped, or the wrong size

#### Step 3: List EVERY difference — no matter how small

Write out each difference explicitly. Examples:
- "Header bg is #18181b but should be #09090b — it's too light"
- "Card border-radius is rounded-lg (8px) but should be rounded-xl (12px)"
- "Gap between nav items is gap-4 but should be gap-6"
- "The search icon is 20px but should be 16px"
- "Button padding is py-2 but should be py-2.5 — text looks too cramped"
- "Muted text is text-zinc-400 but should be text-zinc-500 — it's too bright"

If you find ZERO differences, you may proceed to Phase 5. Otherwise continue the loop.

#### Step 4: Fix EVERY difference

Edit ${outputDir}/index.html. Fix every single issue from your list. Don't skip any.

#### Step 5: Re-screenshot

The Flask server reads index.html from disk on each request, so no restart needed for
HTML/CSS changes. Just take a new screenshot (increment ITERATION number).

#### Step 6: Compare again → go back to Step 2

### Standards — absolute and non-negotiable:

- You MUST complete at least 3 comparison iterations even if it looks great on iteration 1.
  Fresh eyes on later passes ALWAYS find things that were missed.
- "Good enough" is FAILURE. The standard is: if you put both images side by side, a designer
  could not tell which is which.
- Pay extreme attention to: shadow opacity, border color opacity (rgba values), exact padding
  values, font-weight differences between 500 and 600, line-height (1.4 vs 1.5 vs 1.6).
- If you catch yourself thinking "that's close enough" — it's NOT. Fix it.
- DO NOT STOP the loop until a full comparison pass finds ZERO differences.
- Save the diff list for each iteration to ${outputDir}/iteration-N-diffs.md for audit.

---

## Phase 5: Inject Gravity chat + ads

Now that the visual clone is perfect, add the chat integration WITHOUT breaking visual fidelity.

### Identify the input element

Find the main text input or prompt area in the page. Wire it up:

1. Intercept submit (Enter key + click on any send button)
2. Block SPA navigation: override history.pushState and history.replaceState
3. On submit, morph the page into a full-screen chat interface:
   - **Top bar**: match the site's nav — same colors, font, spacing + "New chat" button
   - **Thread**: user bubbles right-aligned, AI responses left with bouncing dots loader
   - **Input bar**: fixed bottom, styled to match the original input EXACTLY
4. Call /api/chat with: { messages: [{role, content}, ...], sessionId: SESSION_ID }
5. Render AI response, then render Gravity ad below it

### Ad rendering — use the official SDK

    let _sdk = null;
    async function getSDK() {
      if (_sdk) return _sdk;
      const v = '18.3.1';
      const [React, { createRoot }, { GravityAd }] = await Promise.all([
        import(\`https://esm.sh/react@\${v}\`),
        import(\`https://esm.sh/react-dom@\${v}/client\`),
        import(\`https://esm.sh/@gravity-ai/react@1.1.6?deps=react@\${v},react-dom@\${v}\`),
      ]);
      _sdk = { React, createRoot, GravityAd };
      return _sdk;
    }

    async function injectAd(ad, slot) {
      if (!slot) return;
      const sdkAd = {
        ...ad,
        favicon: ad.favicon || ad.faviconUrl
          || (ad.clickUrl ? \`https://www.google.com/s2/favicons?sz=32&domain=\${(()=>{try{return new URL(ad.clickUrl).hostname}catch{return ''}})()} \` : undefined),
      };
      slot.style.display = 'block';
      slot.style.fontSize = '15px';
      slot.style.lineHeight = '1.6';
      slot.dataset.gravAdSlot = '1';
      slot.dataset.gravAdData = JSON.stringify(ad);
      const { React, createRoot, GravityAd } = await getSDK();
      createRoot(slot).render(React.createElement(GravityAd, {
        ad: sdkAd,
        variant: AD_VARIANT,
        labelText: 'Ad',
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      }));
    }

Choose the default variant that best fits the site:
- Chat/conversation: 'suggestion' or 'inline'
- Content/article: 'native' or 'contextual'
- Prominent: 'card' or 'accent'

### Floating variant picker — include in EVERY clone

    const ALL_VARIANTS = [
      'inline','card','minimal','bubble','contextual','native','footnote','quote',
      'suggestion','accent','side-panel','labeled','spotlight','embed','split-action',
      'pill','banner','divider','toolbar','tooltip','notification','hyperlink','text-link',
    ];
    let AD_VARIANT = 'inline'; // change to best fit

    (function buildPicker() {
      const s = document.createElement('style');
      s.textContent = \`
        #grav-picker { position:fixed; bottom:20px; right:20px; z-index:99999; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
        #grav-picker-toggle { background:#111; color:#fff; border:none; border-radius:20px; padding:7px 14px; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:6px; box-shadow:0 2px 12px rgba(0,0,0,0.2); white-space:nowrap; }
        #grav-picker-toggle:hover { background:#333; }
        #grav-picker-panel { position:absolute; bottom:42px; right:0; background:#fff; border:1px solid rgba(0,0,0,0.1); border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,0.15); padding:8px; width:190px; display:none; flex-direction:column; gap:1px; max-height:420px; overflow-y:auto; }
        #grav-picker-panel.open { display:flex; }
        .grav-picker-item { padding:7px 10px; border-radius:7px; font-size:12px; cursor:pointer; color:#333; transition:background .1s; }
        .grav-picker-item:hover { background:#f5f5f5; }
        .grav-picker-item.active { background:#111; color:#fff; font-weight:600; }
        #grav-picker-label { font-size:10px; color:#999; padding:4px 10px 6px; text-transform:uppercase; letter-spacing:.5px; }
      \`;
      document.head.appendChild(s);

      const el = document.createElement('div');
      el.id = 'grav-picker';
      el.innerHTML = \`
        <div id="grav-picker-panel">
          <div id="grav-picker-label">Ad variant</div>
          \${ALL_VARIANTS.map(v => \`<div class="grav-picker-item\${v===AD_VARIANT?' active':''}" data-variant="\${v}">\${v}</div>\`).join('')}
        </div>
        <button id="grav-picker-toggle">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="4" height="4" rx="1" fill="currentColor"/><rect x="7" y="1" width="4" height="4" rx="1" fill="currentColor"/><rect x="1" y="7" width="4" height="4" rx="1" fill="currentColor"/><rect x="7" y="7" width="4" height="4" rx="1" fill="currentColor"/></svg>
          <span id="grav-picker-current">\${AD_VARIANT}</span>
        </button>
      \`;
      document.body.appendChild(el);

      const panel = document.getElementById('grav-picker-panel');
      document.getElementById('grav-picker-toggle').addEventListener('click', () => panel.classList.toggle('open'));
      document.addEventListener('click', e => { if (!el.contains(e.target)) panel.classList.remove('open'); });

      panel.addEventListener('click', async e => {
        const item = e.target.closest('.grav-picker-item');
        if (!item) return;
        AD_VARIANT = item.dataset.variant;
        document.getElementById('grav-picker-current').textContent = AD_VARIANT;
        panel.querySelectorAll('.grav-picker-item').forEach(i => i.classList.toggle('active', i.dataset.variant === AD_VARIANT));
        panel.classList.remove('open');
        for (const slot of document.querySelectorAll('[data-grav-ad-slot="1"]')) {
          const ad = JSON.parse(slot.dataset.gravAdData || '{}');
          slot.innerHTML = '';
          await injectAd(ad, slot);
        }
      });
    })();

---

## Phase 6: Final verification — homepage fidelity must survive the injection

After adding the chat integration, take a screenshot of the HOMEPAGE (before any query
is submitted). Compare it to the original image ${imagePath} one final time.

The chat injection must NOT have broken ANY of the visual fidelity from Phase 4.
If it did, fix it.

Then test the chat morph:

    from playwright.sync_api import sync_playwright
    import time
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.goto('http://localhost:${port}', wait_until='networkidle', timeout=15000)
        time.sleep(2)
        page.screenshot(path='${outputDir}/final-homepage.png', full_page=True)
        try:
            inp = page.locator('div[contenteditable=true], textarea, input[type=text]').first
            inp.fill('what are the best credit cards in 2024')
            inp.press('Enter')
            time.sleep(15)
            page.evaluate('try{document.querySelector(".grav-thread,.grav-thread-inner,[id*=thread]").scrollTop=99999}catch(e){}')
            time.sleep(1)
        except Exception as e:
            print('input error:', e)
        page.screenshot(path='${outputDir}/final-chat.png', full_page=True)
        browser.close()

Verify:
1. Homepage is STILL pixel-perfect compared to original image
2. Chat morph works and looks like a native feature of the site
3. Gravity ad appears below the AI response with favicon
4. Variant picker is visible in bottom-right

Report: local URL, iteration count, visual fidelity notes.
`;
}

async function cmdCloneFromImage(imagePath, name, port, notes, cfg) {
  const outputDir = path.join(CLONES_DIR, name);
  fs.mkdirSync(outputDir, { recursive: true });

  // Copy source image into the clone directory so the agent can reference it locally
  const ext = path.extname(imagePath) || ".png";
  const imgDest = path.join(outputDir, `source-image${ext}`);
  fs.copyFileSync(imagePath, imgDest);

  console.log(`\n🖼️   Cloning from image: ${imagePath}`);
  console.log(`📁  Output:  ${outputDir}`);
  console.log(`🔌  Port:    ${port}`);
  if (notes) console.log(`📝  Notes:   ${notes}`);
  console.log();

  const prompt = buildImagePrompt({
    imagePath: imgDest, port, outputDir, name, notes,
    gravityKey: cfg.gravity_publisher_key,
  });

  const tmpFile = path.join(os.tmpdir(), `gravclone-img-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt);

  try {
    spawnSync(
      "claude",
      ["--dangerously-skip-permissions", "-p", fs.readFileSync(tmpFile, "utf8")],
      { stdio: "inherit", cwd: outputDir }
    );
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function cmdClone(url, port, notes, cfg, auth = false) {
  const { execSync } = await import("child_process");
  const domain    = new URL(url).hostname.replace(/^www\./, "");
  const outputDir = path.join(CLONES_DIR, domain);
  fs.mkdirSync(outputDir, { recursive: true });

  if (auth) {
    if (!isDebugChromeRunning()) {
      console.error(`\n✗  --auth requires debug Chrome running on port ${CDP_PORT}.`);
      console.error(`   Run:  gravclone chrome`);
      console.error(`   Then log into ${domain} in that Chrome window before cloning.\n`);
      process.exit(1);
    }
    console.log(`\n🔐  AUTH mode — attaching to your logged-in Chrome on port ${CDP_PORT}`);
  }

  console.log(`\n🌐  Cloning:  ${url}`);
  console.log(`📁  Output:   ${outputDir}`);
  console.log(`🔌  Port:     ${port}`);
  console.log();

  const prompt = buildPrompt({
    url, port, outputDir, domain, notes,
    gravityKey:    cfg.gravity_publisher_key,
    auth,
  });

  // Write prompt to a temp file to avoid any shell quoting issues
  const tmpFile = path.join(os.tmpdir(), `gravclone-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt);

  try {
    spawnSync(
      "claude",
      ["--dangerously-skip-permissions", "-p", fs.readFileSync(tmpFile, "utf8")],
      { stdio: "inherit", cwd: outputDir }
    );
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// ── Publish (upload to hub) ──────────────────────────────────────────────────

function slugFromDomain(domain) {
  // delphi.ai → delphi; runable.com → runable; foo.bar.baz → foo-bar
  const noWww = domain.replace(/^www\./, "");
  return noWww.split(".").slice(0, -1).join("-").toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-") || noWww.toLowerCase();
}

async function cmdPublish(domain, { slug, password }) {
  const { execSync } = await import("child_process");
  const cfg = loadConfig();
  if (!cfg.hub_url || !cfg.hub_token) {
    console.error("\n✗  Hub not configured. Set these in ~/.config/gravclone/config.json:");
    console.error('      "hub_url":   "https://demos.trygravity.ai"');
    console.error('      "hub_token": "<token from the hub admin>"\n');
    process.exit(1);
  }
  const cloneDir = path.join(CLONES_DIR, domain);
  if (!fs.existsSync(path.join(cloneDir, "index.html"))) {
    console.error(`\n✗  No clone at ${cloneDir}. Run: gravclone ${domain}\n`);
    process.exit(1);
  }

  slug = slug || slugFromDomain(domain);

  // Stage a temp dir with a publish-ready copy of the clone:
  //  - strip server.py (hub provides /api/chat itself)
  //  - rewrite `/api/chat` → `./api/chat` so the path works under /<slug>/
  //  - keep assets/ and index.html (+ grav-favicon.png)
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "gc-publish-"));
  try {
    const copy = (src, dst) => {
      const s = fs.statSync(src);
      if (s.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const e of fs.readdirSync(src)) copy(path.join(src, e), path.join(dst, e));
      } else {
        fs.copyFileSync(src, dst);
      }
    };
    const SKIP = new Set([
      "server.py", "capture.py", "rewrite.py", "test.py",
      "page-raw.html", "asset-map.json",
      "01-homepage.png", "02-after-query.png",
      "before-typing.png", "after-typing.png", "final.png",
      "__pycache__",
    ]);
    for (const e of fs.readdirSync(cloneDir)) {
      if (SKIP.has(e)) continue;
      copy(path.join(cloneDir, e), path.join(stage, e));
    }
    // Rewrite index.html
    const idx = path.join(stage, "index.html");
    let html  = fs.readFileSync(idx, "utf8");
    html = html.replace(/(['"`])\/api\/chat\1/g, '$1./api/chat$1');
    fs.writeFileSync(idx, html);

    // Zip it
    const zipPath = path.join(os.tmpdir(), `gc-publish-${Date.now()}.zip`);
    execSync(`cd "${stage}" && zip -rq "${zipPath}" .`, { stdio: "pipe" });
    const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);

    const hubUrl = cfg.hub_url.replace(/\/+$/, "");
    console.log(`\n⬆  Uploading to ${hubUrl} (slug: ${slug}, ${sizeMb} MB)...`);

    // Upload with curl so we don't need extra Node deps
    const curlCmd = [
      "curl", "-sS", "-X", "POST", `${hubUrl}/api/publish`,
      "-H", `Authorization: Bearer ${cfg.hub_token}`,
      "-F", `slug=${slug}`,
      "-F", `domain=${domain}`,
      ...(password ? ["-F", `password=${password}`] : []),
      "-F", `zip=@${zipPath}`,
      "-w", "\\n__HTTP__%{http_code}",
    ];
    const r = spawnSync(curlCmd[0], curlCmd.slice(1), { encoding: "utf8" });
    try { fs.unlinkSync(zipPath); } catch {}
    if (r.status !== 0) {
      console.error(`\n✗  curl failed: ${r.stderr || r.stdout}\n`);
      process.exit(1);
    }
    const [body, httpLine] = r.stdout.split("__HTTP__");
    const httpCode = (httpLine || "").trim();
    if (httpCode !== "200") {
      console.error(`\n✗  hub returned HTTP ${httpCode}: ${body.trim()}\n`);
      process.exit(1);
    }
    let resp = {};
    try { resp = JSON.parse(body); } catch {}
    console.log(`\n✓  Published:  ${resp.url || `${hubUrl}/${slug}/`}`);
    if (resp.password_required) console.log(`🔒  Password:   ${password}`);
    console.log();
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

// ── Zip ───────────────────────────────────────────────────────────────────────

async function cmdZip(domain) {
  const { execSync } = await import("child_process");
  const cloneDir = path.join(CLONES_DIR, domain);

  if (!fs.existsSync(cloneDir)) {
    console.error(`\nNo clone found for "${domain}". Run: gravclone ${domain}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(cloneDir, "server.py"))) {
    console.error(`\nClone for "${domain}" is missing server.py — re-run gravclone ${domain}\n`);
    process.exit(1);
  }

  // Read the port from server.py
  const serverSrc = fs.readFileSync(path.join(cloneDir, "server.py"), "utf8");
  const portMatch = serverSrc.match(/PORT\s*=\s*(\d+)|app\.run\(port=(\d+)/);
  const port = portMatch ? (portMatch[1] || portMatch[2]) : "8080";

  // Write start.sh
  const startSh = `#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  gravclone — ${domain}"
echo ""

# Install Python deps if needed
if ! python3 -c "import flask, requests" 2>/dev/null; then
  echo "  Installing dependencies..."
  pip3 install flask requests -q
fi

# Kill anything on port ${port}
lsof -ti :${port} | xargs kill -9 2>/dev/null || true
sleep 0.5

echo "  Starting server on http://localhost:${port}"
echo "  Press Ctrl+C to stop."
echo ""

# Open browser after 1.5s
(sleep 1.5 && open "http://localhost:${port}" 2>/dev/null || xdg-open "http://localhost:${port}" 2>/dev/null || true) &

python3 server.py
`;
  fs.writeFileSync(path.join(cloneDir, "start.sh"), startSh, { mode: 0o755 });

  // Write README
  const readme = `# ${domain} — Gravity Ads Demo

## Quick start

    ./start.sh

Opens http://localhost:${port} in your browser automatically.
Requires Python 3 (dependencies installed automatically on first run).

## What this is

A local clone of ${domain} with live AI responses (Pollinations.ai — free, no key needed)
and Gravity contextual ads injected below each response.

Powered by Pollinations.ai (free, no API key required) + Gravity Ads.

Use the variant picker (bottom-right corner) to switch between 23 ad formats in real time.
`;
  fs.writeFileSync(path.join(cloneDir, "README.md"), readme);

  // Build the zip, excluding screenshot/debug files and __pycache__
  const zipName = `gravclone-${domain}.zip`;
  const zipPath = path.join(os.homedir(), "Desktop", zipName);

  const exclude = [
    "--exclude=*/__pycache__/*",
    "--exclude=*.pyc",
    "--exclude=*/capture.py",
    "--exclude=*/*.png",   // skip screenshots, keep grav-favicon.png
  ].join(" ");

  // Re-include grav-favicon.png specifically
  execSync(
    `cd "${CLONES_DIR}" && zip -r "${zipPath}" "${domain}" ${exclude} -i "${domain}/*" && zip "${zipPath}" "${domain}/grav-favicon.png" 2>/dev/null || true`,
    { stdio: "pipe" }
  );

  const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);

  console.log(`
  ✓  Zipped to ~/Desktop/${zipName}  (${sizeMb} MB)

  Recipient just needs Python 3 installed, then:
    unzip ${zipName}
    cd ${domain}
    ./start.sh
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2);
  // Pull out --auth anywhere in argv; rest are positional
  const auth = rawArgs.includes("--auth");
  const args = rawArgs.filter(a => a !== "--auth");

  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(`
gravclone — Clone any publisher site with live AI + Gravity ads

Usage:
  gravclone <url> [port] [notes] [--auth]      Clone from a live URL (default port: 8080)
  gravclone image <path> [name] [port] [notes] Clone from a screenshot image
  gravclone chrome [--refresh]                 Launch a stealth Chrome (clones your real
                                               profile: cookies, history, extensions).
                                               --refresh re-syncs from your main profile.
  gravclone setup                              Configure API keys
  gravclone list                               Show all clones
  gravclone zip <domain>                       Package a clone for sharing
  gravclone publish <domain> [--password X]    Upload to the hub and get a public URL
                         [--slug Y]

Flags:
  --auth    Attach to your already-running debug Chrome (port ${CDP_PORT}) so
            the cloner captures the REAL logged-in UI. Run 'gravclone chrome'
            first, log into the site there, then re-run with --auth.

Examples:
  gravclone chatgpt.com
  gravclone https://presearch.com 8081
  gravclone chrome                         # launch debug Chrome, log into Delphi
  gravclone delphi.ai --auth               # clone the authed Delphi UI
  gravclone image ./screenshot.png daimon 8081
  gravclone zip runable.com        → ~/Desktop/gravclone-runable.com.zip

Requires: claude CLI  (npm install -g @anthropic-ai/claude-code)
          python3 + flask + requests
`);
    process.exit(0);
  }

  if (args[0] === "setup")   { await cmdSetup(); return; }
  if (args[0] === "list")    { cmdList(); return; }
  if (args[0] === "chrome")  { cmdChrome({ refresh: args.includes("--refresh") }); return; }
  if (args[0] === "zip")     { await cmdZip(args[1]?.replace(/^https?:\/\//, "").replace(/^www\./, "") || ""); return; }
  if (args[0] === "publish") {
    const domain = (args[1] || "").replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (!domain) {
      console.error("\nUsage: gravclone publish <domain> [--password X] [--slug Y]\n");
      process.exit(1);
    }
    const passIdx = rawArgs.indexOf("--password");
    const slugIdx = rawArgs.indexOf("--slug");
    const password = passIdx >= 0 ? rawArgs[passIdx + 1] : null;
    const slug     = slugIdx >= 0 ? rawArgs[slugIdx + 1] : null;
    await cmdPublish(domain, { slug, password });
    return;
  }

  // Image clone
  if (args[0] === "image") {
    if (!args[1]) {
      console.error("\nUsage: gravclone image <path-to-image> [name] [port] [notes]\n");
      process.exit(1);
    }
    const imgPath = path.resolve(args[1]);
    if (!fs.existsSync(imgPath)) {
      console.error(`\nImage not found: ${imgPath}\n`);
      process.exit(1);
    }
    let name, port = 8080, notes = "";
    let ai = 2;
    if (args[ai] && isNaN(parseInt(args[ai]))) { name = args[ai]; ai++; }
    if (args[ai] && !isNaN(parseInt(args[ai]))) { port = parseInt(args[ai]); ai++; }
    if (args[ai]) { notes = args.slice(ai).join(" "); }
    if (!name) name = path.basename(imgPath, path.extname(imgPath)).replace(/[^a-zA-Z0-9._-]/g, "-");
    const cfg = await ensureConfig();
    await cmdCloneFromImage(imgPath, name, port, notes, cfg);
    return;
  }

  // Clone
  let url = args[0];
  if (!url.startsWith("http")) url = `https://${url}`;

  const port  = parseInt(args[1]) || 8080;
  const notes = args[2] || "";

  const cfg = await ensureConfig();
  await cmdClone(url, port, notes, cfg, auth);
}

main().catch(err => { console.error(err); process.exit(1); });
