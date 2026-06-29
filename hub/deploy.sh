#!/usr/bin/env bash
# Deploy the gravclone hub to the EC2 box.
# Usage:  ./deploy.sh <ssh-host> [--domain demos.trygravity.ai]
#
# Assumes:
#   - cloud-init (user-data.sh) has finished on the host
#   - SSH key is in ~/.ssh/gravclone-hub.pem
#   - you're running from the hub/ directory
#
# Env vars the script requires:
#   GRAVCLONE_HUB_TOKEN       shared secret for POST /api/publish
#   GRAVITY_PUBLISHER_KEY     key to call server.trygravity.ai/api/v1/ad
#   GRAVCLONE_COOKIE_SECRET   (optional) stable cookie HMAC key; random if omitted
set -euo pipefail

HOST="${1:-}"
DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "Usage: $0 <ssh-host> [--domain demos.trygravity.ai]" >&2
  exit 1
fi

: "${GRAVCLONE_HUB_TOKEN:?set GRAVCLONE_HUB_TOKEN}"
: "${GRAVITY_PUBLISHER_KEY:?set GRAVITY_PUBLISHER_KEY}"

KEY="$HOME/.ssh/gravclone-hub.pem"
SCP="scp -i $KEY -o StrictHostKeyChecking=accept-new"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new"

echo "📦  Copying hub code to $HOST..."
$SSH "ubuntu@$HOST" "sudo install -d -o gravclone -g gravclone /opt/gravclone"
$SCP hub.py requirements.txt "ubuntu@$HOST:/tmp/"
$SSH "ubuntu@$HOST" "sudo mv /tmp/hub.py /tmp/requirements.txt /opt/gravclone/ && sudo chown gravclone:gravclone /opt/gravclone/hub.py /opt/gravclone/requirements.txt"

echo "🐍  Installing Python deps..."
$SSH "ubuntu@$HOST" "sudo -u gravclone /opt/gravclone/venv/bin/pip install -r /opt/gravclone/requirements.txt -q"

echo "🔐  Writing /etc/gravclone/env..."
COOKIE_SECRET="${GRAVCLONE_COOKIE_SECRET:-$(openssl rand -hex 32)}"
ENV_CONTENT=$(cat <<EOF
GRAVCLONE_HUB_TOKEN=$GRAVCLONE_HUB_TOKEN
GRAVITY_PUBLISHER_KEY=$GRAVITY_PUBLISHER_KEY
GRAVCLONE_COOKIE_SECRET=$COOKIE_SECRET
GRAVCLONE_HUB_ROOT=/srv/gravclones
PORT=8000
EOF
)
$SSH "ubuntu@$HOST" "sudo tee /etc/gravclone/env > /dev/null <<'ENV'
$ENV_CONTENT
ENV
sudo chmod 600 /etc/gravclone/env && sudo chown gravclone:gravclone /etc/gravclone/env"

echo "🌐  Configuring Caddy..."
if [ -n "$DOMAIN" ]; then
  $SSH "ubuntu@$HOST" "sudo tee /etc/caddy/Caddyfile > /dev/null <<CADDY
$DOMAIN {
  reverse_proxy 127.0.0.1:8000
}
:80 {
  # also respond on bare IP so pre-DNS testing works
  reverse_proxy 127.0.0.1:8000
}
CADDY"
else
  $SSH "ubuntu@$HOST" "sudo tee /etc/caddy/Caddyfile > /dev/null <<CADDY
:80 {
  reverse_proxy 127.0.0.1:8000
}
CADDY"
fi
$SSH "ubuntu@$HOST" "sudo systemctl reload caddy || sudo systemctl restart caddy"

echo "🚀  Starting gravclone-hub service..."
$SSH "ubuntu@$HOST" "sudo systemctl enable --now gravclone-hub && sudo systemctl restart gravclone-hub"

sleep 2
echo "🔎  Health check..."
$SSH "ubuntu@$HOST" "curl -s http://127.0.0.1:8000/healthz" || true
echo
echo "🔎  External check (via Caddy)..."
curl -s -o /dev/null -w "HTTP %{http_code}\n" "http://$HOST/healthz" || true

echo
echo "✓  Deployed."
[ -n "$DOMAIN" ] && echo "  Point A record for $DOMAIN → $HOST (instance IP)."
echo "  Hub URL (pre-DNS): http://$HOST"
