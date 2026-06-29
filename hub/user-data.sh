#!/bin/bash
# gravclone hub cloud-init — runs once on first boot.
# Installs Python, Caddy, creates the gravclone user, sets up the hub service.
# Secrets (token, Gravity key, domain) are written by the deploy script later.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y \
  python3 python3-pip python3-venv \
  curl debian-keyring debian-archive-keyring apt-transport-https \
  unzip ca-certificates gnupg

# Caddy (official repo)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# User + dirs
id gravclone >/dev/null 2>&1 || useradd --system --home /opt/gravclone --shell /usr/sbin/nologin gravclone
mkdir -p /opt/gravclone /srv/gravclones /etc/gravclone
chown -R gravclone:gravclone /opt/gravclone /srv/gravclones /etc/gravclone

# Python venv (the app lands here via scp in the deploy step)
sudo -u gravclone python3 -m venv /opt/gravclone/venv

# Systemd unit — EnvironmentFile is populated by deploy script
cat >/etc/systemd/system/gravclone-hub.service <<'UNIT'
[Unit]
Description=gravclone hub
After=network.target

[Service]
User=gravclone
Group=gravclone
WorkingDirectory=/opt/gravclone
EnvironmentFile=/etc/gravclone/env
ExecStart=/opt/gravclone/venv/bin/gunicorn -w 2 -b 127.0.0.1:8000 --access-logfile - hub:app
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

# Placeholder Caddyfile — deploy script replaces with real domain
cat >/etc/caddy/Caddyfile <<'CADDY'
:80 {
  reverse_proxy 127.0.0.1:8000
}
CADDY

systemctl daemon-reload
systemctl enable caddy
# gravclone-hub is NOT started here — deploy script installs code + env, then starts it
echo "cloud-init complete — awaiting deploy"
