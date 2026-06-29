"""
gravclone hub — hosts many gravclones under one domain.

Endpoints:
  POST /api/publish                   — upload a zipped clone (bearer token auth)
  GET  /<slug>/                       — serve the clone's index.html (password gate if set)
  GET  /<slug>/<path>                 — serve static files for the clone
  POST /<slug>/api/chat               — proxy AI + Gravity ad, using hub-owned publisher key
  GET  /                              — simple index of published clones
  GET  /healthz                       — liveness

Storage layout:
  /srv/gravclones/<slug>/             — unzipped clone (index.html, assets/, server.py, ...)
  /srv/gravclones/_meta/<slug>.json   — {password, created_at, domain, source_server}
"""
import concurrent.futures
import hmac
import json
import os
import re
import secrets
import shutil
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import requests as req
from flask import (
    Flask, abort, jsonify, make_response, redirect, request,
    send_from_directory,
)

ROOT       = Path(os.environ.get("GRAVCLONE_HUB_ROOT", "/srv/gravclones"))
META_DIR   = ROOT / "_meta"
TOKEN      = os.environ["GRAVCLONE_HUB_TOKEN"]
GRAV_KEY   = os.environ["GRAVITY_PUBLISHER_KEY"]
COOKIE_KEY = os.environ.get("GRAVCLONE_COOKIE_SECRET", secrets.token_hex(32))
MAX_UPLOAD = 100 * 1024 * 1024  # 100 MB

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

ROOT.mkdir(parents=True, exist_ok=True)
META_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD


def _meta_path(slug: str) -> Path:
    return META_DIR / f"{slug}.json"


def _load_meta(slug: str):
    p = _meta_path(slug)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def _save_meta(slug: str, data: dict):
    _meta_path(slug).write_text(json.dumps(data, indent=2))


def _cookie_token(slug: str) -> str:
    return hmac.new(COOKIE_KEY.encode(), slug.encode(), "sha256").hexdigest()[:32]


def _is_unlocked(slug: str, meta: dict) -> bool:
    if not meta.get("password"):
        return True
    return request.cookies.get(f"gc_{slug}") == _cookie_token(slug)


# ── Publish ─────────────────────────────────────────────────────────────────

@app.post("/api/publish")
def publish():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or not secrets.compare_digest(auth[7:], TOKEN):
        abort(401)

    slug = (request.form.get("slug") or "").strip().lower()
    if not SLUG_RE.match(slug):
        return jsonify(error="invalid slug — use [a-z0-9._-], 1-64 chars"), 400
    if slug.startswith("_") or slug in {"api", "healthz", "static"}:
        return jsonify(error="reserved slug"), 400

    if "zip" not in request.files:
        return jsonify(error="missing 'zip' file"), 400

    password = (request.form.get("password") or "").strip() or None
    domain   = (request.form.get("domain") or "").strip() or None

    target = ROOT / slug
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    tmp_zip = ROOT / f"_upload_{uuid.uuid4().hex}.zip"
    request.files["zip"].save(tmp_zip)
    try:
        with zipfile.ZipFile(tmp_zip) as zf:
            # Zip may contain a top-level <domain>/ dir (from gravclone zip) — flatten it.
            names  = zf.namelist()
            top    = {n.split("/", 1)[0] for n in names if "/" in n}
            strip  = top.pop() + "/" if len(top) == 1 and all(
                n.startswith(next(iter(top)) + "/") or n == next(iter(top)) for n in names
            ) else ""
            for member in zf.infolist():
                name = member.filename
                if strip and name.startswith(strip):
                    name = name[len(strip):]
                if not name or name.endswith("/"):
                    continue
                # Guard against path traversal
                dst = (target / name).resolve()
                if ROOT.resolve() not in dst.parents:
                    return jsonify(error=f"unsafe path in zip: {member.filename}"), 400
                dst.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, open(dst, "wb") as out:
                    shutil.copyfileobj(src, out)
    finally:
        tmp_zip.unlink(missing_ok=True)

    if not (target / "index.html").exists():
        shutil.rmtree(target)
        return jsonify(error="zip did not contain index.html at the top level"), 400

    _save_meta(slug, {
        "slug":          slug,
        "domain":        domain,
        "password":      password,
        "created_at":    datetime.now(timezone.utc).isoformat(),
        "source_server": target.joinpath("server.py").exists(),
    })

    base = request.headers.get("X-Forwarded-Host") or request.host
    scheme = request.headers.get("X-Forwarded-Proto") or request.scheme
    public_url = f"{scheme}://{base}/{slug}/"
    return jsonify(url=public_url, slug=slug, password_required=bool(password))


@app.delete("/api/publish/<slug>")
def unpublish(slug):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or not secrets.compare_digest(auth[7:], TOKEN):
        abort(401)
    if not SLUG_RE.match(slug):
        abort(400)
    target = ROOT / slug
    if target.exists():
        shutil.rmtree(target)
    _meta_path(slug).unlink(missing_ok=True)
    return jsonify(ok=True)


# ── Password gate ───────────────────────────────────────────────────────────

GATE_HTML = """<!doctype html>
<meta charset=utf-8>
<title>Locked — gravclone</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#0b0b0f; color:#eaeaea; display:flex; align-items:center;
         justify-content:center; min-height:100vh; }
  .box { background:#16161d; border:1px solid #2a2a33; border-radius:14px; padding:28px 32px;
         max-width:360px; width:100%; box-shadow:0 10px 40px rgba(0,0,0,0.4); }
  h1 { margin:0 0 6px; font-size:18px; font-weight:600; }
  p { margin:0 0 18px; color:#999; font-size:13px; }
  input { width:100%; padding:11px 13px; border-radius:9px; border:1px solid #2a2a33;
          background:#0b0b0f; color:#eaeaea; font-size:14px; box-sizing:border-box; }
  input:focus { outline:none; border-color:#5b8def; }
  button { width:100%; margin-top:12px; padding:11px; border-radius:9px; border:none;
           background:#5b8def; color:#fff; font-weight:600; font-size:14px; cursor:pointer; }
  button:hover { background:#4e7fda; }
  .err { color:#ff6b6b; font-size:12px; margin-top:10px; min-height:1em; }
</style>
<div class=box>
  <h1>Password required</h1>
  <p>This gravclone is gated. Enter the password to continue.</p>
  <form method=post>
    <input name=password type=password autofocus placeholder="Password" />
    <button type=submit>Unlock</button>
    <div class=err>__ERR__</div>
  </form>
</div>
"""


def _gate_page(err=""):
    return GATE_HTML.replace("__ERR__", err), 401 if err else 200


@app.route("/<slug>/", methods=["GET", "POST"])
def slug_root(slug):
    return _serve(slug, "index.html")


@app.route("/<slug>/<path:path>", methods=["GET", "POST"])
def slug_path(slug, path):
    # /<slug>/api/chat is handled separately below
    if path == "api/chat" and request.method == "POST":
        return slug_chat(slug)
    return _serve(slug, path)


def _serve(slug, path):
    if not SLUG_RE.match(slug):
        abort(404)
    meta = _load_meta(slug)
    if meta is None:
        abort(404)
    clone_dir = ROOT / slug
    if not clone_dir.exists():
        abort(404)

    if meta.get("password"):
        if request.method == "POST" and path == "index.html":
            supplied = (request.form.get("password") or "").strip()
            if supplied and secrets.compare_digest(supplied, meta["password"]):
                resp = make_response(redirect(request.path))
                resp.set_cookie(
                    f"gc_{slug}", _cookie_token(slug),
                    max_age=60*60*24*30, httponly=True,
                    secure=request.headers.get("X-Forwarded-Proto") == "https",
                    samesite="Lax",
                )
                return resp
            return _gate_page("Wrong password" if supplied else "")
        if not _is_unlocked(slug, meta):
            return _gate_page()

    base = clone_dir.resolve()
    full = (clone_dir / path).resolve()
    if base not in full.parents and full != base:
        abort(404)
    if full.is_dir():
        full = full / "index.html"
    if not full.is_file():
        abort(404)
    return send_from_directory(base, str(full.relative_to(base)))


# ── Per-clone AI + ad proxy ─────────────────────────────────────────────────

def slug_chat(slug):
    meta = _load_meta(slug)
    if meta is None:
        abort(404)
    if not _is_unlocked(slug, meta):
        abort(401)
    data       = request.get_json(silent=True) or {}
    messages   = data.get("messages", [])
    session_id = data.get("sessionId", str(uuid.uuid4()))
    client_ip  = request.headers.get("X-Forwarded-For", request.remote_addr)

    def call_ai():
        try:
            r = req.post(
                "https://text.pollinations.ai/openai",
                headers={"Content-Type": "application/json"},
                json={"model": "openai", "messages": messages},
                timeout=30,
            )
            return r.json()["choices"][0]["message"]["content"]
        except Exception as e:
            return f"(AI error: {e})"

    def call_gravity():
        import logging
        try:
            r = req.post(
                "https://server.trygravity.ai/api/v1/ad",
                headers={
                    "Authorization": f"Bearer {GRAV_KEY}",
                    "Content-Type":  "application/json",
                },
                json={
                    "messages":   [{k: m[k] for k in ("role", "content")}
                                   for m in messages[-2:] if "role" in m and "content" in m],
                    "sessionId":  f"{slug}:{session_id}",
                    "placements": [
                        {"placement": "below_response", "placement_id": "main"},
                        {"placement": "below_response", "placement_id": "alt1"},
                        {"placement": "below_response", "placement_id": "alt2"},
                    ],
                    "user":       {"id": "anonymous"},
                    "device":     {"ip": client_ip},
                    "relevancy":  0.2,
                    "testAd":     False,
                },
                timeout=10,
            )
            print(f"[gravity] slug={slug} status={r.status_code} bytes={len(r.content or b'')}", flush=True)
            if r.ok and r.content:
                d = r.json()
                print(f"[gravity] payload_type={type(d).__name__} len={len(d) if hasattr(d,'__len__') else '?'} sample={repr(d)[:300]}", flush=True)
                if isinstance(d, list) and d:
                    return d
                if isinstance(d, dict):
                    if d.get("brandName"):
                        return [d]
                    # Some APIs wrap in {"ads": [...]}
                    if isinstance(d.get("ads"), list) and d["ads"]:
                        return d["ads"]
        except Exception as e:
            print(f"[gravity] EXCEPTION slug={slug}: {e}", flush=True)
        return [{
            "brandName": "Gravity",
            "title":     "Native Ads for AI Interfaces",
            "adText":    "Context-aware advertising built for AI-native products.",
            "cta":       "Learn more",
            "clickUrl":  "https://trygravity.ai",
            "favicon":   f"/{slug}/grav-favicon.png",
        }]

    with concurrent.futures.ThreadPoolExecutor() as ex:
        ai_f = ex.submit(call_ai)
        ad_f = ex.submit(call_gravity)
        return jsonify(response=ai_f.result(), ads=ad_f.result())


# ── Index + health ──────────────────────────────────────────────────────────

@app.get("/")
def index():
    rows = []
    for m in sorted(META_DIR.glob("*.json")):
        meta = json.loads(m.read_text())
        rows.append(
            f'<li><a href="/{meta["slug"]}/">{meta["slug"]}</a>'
            f' <span class=d>{meta.get("domain") or ""}</span>'
            f'{" 🔒" if meta.get("password") else ""}</li>'
        )
    body = "\n".join(rows) or "<li class=empty>No clones published yet.</li>"
    return f"""<!doctype html><meta charset=utf-8><title>gravclones</title>
<style>
  body {{ font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
          background:#0b0b0f; color:#eaeaea; margin:0; padding:60px 20px; }}
  .wrap {{ max-width:640px; margin:0 auto; }}
  h1 {{ font-weight:600; font-size:22px; margin:0 0 8px; }}
  p {{ color:#888; margin:0 0 32px; font-size:13px; }}
  ul {{ list-style:none; padding:0; margin:0; }}
  li {{ padding:12px 16px; border:1px solid #1f1f27; border-radius:10px;
        margin-bottom:8px; display:flex; gap:12px; align-items:center; }}
  li.empty {{ color:#666; }}
  a {{ color:#eaeaea; text-decoration:none; font-weight:500; }}
  a:hover {{ color:#5b8def; }}
  .d {{ color:#666; font-size:12px; }}
</style>
<div class=wrap>
  <h1>gravclones</h1>
  <p>Hosted demos of publisher sites with live Gravity ads.</p>
  <ul>{body}</ul>
</div>"""


@app.get("/healthz")
def healthz():
    return jsonify(ok=True, clones=len(list(META_DIR.glob("*.json"))))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
