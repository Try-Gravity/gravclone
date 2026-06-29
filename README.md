# gravclone

Clone any AI publisher site locally with live AI responses and Gravity ads injected — one command.

Built for the Gravity sales team to demo ad placements on any publisher's actual UI without touching their production systems.

## What it does

1. **Captures** the publisher's homepage (HTML, CSS, images, fonts) using a headless browser
2. **Rebuilds** it as a local static site with a Python Flask backend
3. **Injects** a full chat interface that morphs the page into a working AI assistant
4. **Renders** Gravity ads below each AI response using the official `@gravity-ai/react` SDK
5. **Includes** a real-time variant picker to switch between 23 ad formats on the fly

The result looks indistinguishable from the real site — except it actually responds to queries and shows Gravity ads.

## Install

```bash
npm install -g gravclone
```

### Requirements

| Tool | Purpose |
|------|---------|
| Node 18+ | Runs the CLI |
| Python 3 | Runs the local server + asset capture |
| [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) | Powers the agentic cloning process |
| Playwright | Headless browser for asset capture (`pip3 install playwright && playwright install chromium`) |
| Flask | Local server (`pip3 install flask requests`) |

## Quick start

```bash
# First time — set your Gravity publisher key
gravclone setup

# Clone a site
gravclone runable.com

# Opens at http://localhost:8080
# Type a query, hit Enter — watch it morph into a chat with ads
```

## Commands

```
gravclone <url> [port] [notes]                Clone from a live URL (default port: 8080)
gravclone image <path> [name] [port] [notes]  Clone from a screenshot image
gravclone setup                               Configure your Gravity publisher key
gravclone list                                Show all clones
gravclone zip <domain>                        Package a clone for sharing
```

### Examples

```bash
# Clone from a live URL
gravclone chatgpt.com
gravclone manus.im 8081
gravclone rork.app 8082 "mobile app builder, dark theme"

# Clone from a screenshot
gravclone image ./screenshot.png
gravclone image ~/Desktop/daimon-ui.png daimon 8081
gravclone image ./publisher-chat.png my-publisher 8082 "dark theme, chat interface"

# Package for sharing
gravclone zip runable.com        # → ~/Desktop/gravclone-runable.com.zip
```

## Image cloning

When you have a screenshot but no live URL (or when the live site doesn't capture well), use the `image` command. It builds a pixel-perfect HTML/CSS replica from the screenshot using an iterative visual comparison loop:

1. Claude analyzes the image in forensic detail (colors, spacing, typography, components)
2. Builds a Tailwind CSS replica from scratch
3. Screenshots the build and compares it to the original image
4. Lists every difference and fixes them
5. Repeats until the comparison finds zero differences (minimum 3 iterations)
6. Injects the Gravity chat + ads integration

The `name` argument controls the clone directory name (defaults to the image filename).

## Sharing clones

```bash
gravclone zip runable.com
```

Drops a self-contained zip on your Desktop. Recipient just needs Python 3:

```bash
unzip gravclone-runable.com.zip
cd runable.com
./start.sh
```

Browser opens automatically. No API keys needed — AI responses are powered by [Pollinations.ai](https://pollinations.ai) (free, no signup).

## Ad variant picker

Every clone includes a floating button in the bottom-right corner. Click it to switch between all 23 ad variants in real time:

`inline` · `suggestion` · `card` · `minimal` · `bubble` · `native` · `accent` · `pill` · `banner` · `notification` · `tooltip` · `divider` · and more

The ads are rendered using the official [`@gravity-ai/react`](https://www.npmjs.com/package/@gravity-ai/react) SDK, loaded at runtime from [esm.sh](https://esm.sh).

## How it works

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full technical breakdown.

## File structure

```
~/.config/gravclone/
  config.json              # Gravity publisher key

~/.gravclone/clones/
  runable.com/
    index.html             # Rebuilt HTML with chat injection
    server.py              # Flask backend (AI + Gravity API)
    grav-favicon.png       # Gravity favicon served locally
    assets/                # Captured CSS, JS, images, fonts
    capture.py             # Asset capture script (Playwright)
    page-raw.html          # Original rendered HTML
    asset-map.json         # URL → local path mapping
```
