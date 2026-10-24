#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
SERVICE=docker-logs-viewer
UNIT=/etc/systemd/system/$SERVICE.service
NGINX_CONF=/etc/nginx/conf.d/$SERVICE.conf
ACME_ROOT=/var/www/$SERVICE-acme
CONFIG="$APP_DIR/config.env"

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then exec sudo bash "$APP_DIR/start.sh" "$@"; fi
  echo "Run as root: sudo bash start.sh"; exit 1
fi

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then yum install -y "$@"
  else die "Unsupported package manager. Install $* manually."; fi
}

APT_UPDATED=0
apt_update_once() {
  if command -v apt-get >/dev/null 2>&1 && [ "$APT_UPDATED" -eq 0 ]; then apt-get update -y; APT_UPDATED=1; fi
}

load_config() {
  if [ ! -f "$CONFIG" ]; then
    cp "$APP_DIR/config.example.env" "$CONFIG"
    say "Created config.env from config.example.env"
  fi
  chmod 600 "$CONFIG"
  set -a
  . "$CONFIG"
  set +a
  PORT=${PORT:-6060}
  AUTH_USER=${AUTH_USER:-admin}
  AUTH_PASS=${AUTH_PASS:-}
  DOMAIN=${DOMAIN:-}
  DOMAIN_HTTPS=${DOMAIN_HTTPS:-true}
  CERTBOT_EMAIL=${CERTBOT_EMAIL:-}
  HTTPS_PORT=${HTTPS_PORT:-443}
  SKIP_DNS_CHECK=${SKIP_DNS_CHECK:-false}
  MAX_LINES=${MAX_LINES:-100000}
  MAX_STREAMS=${MAX_STREAMS:-20}
  LOGIN=${LOGIN:-false}
  ALLOWED_IPS=${ALLOWED_IPS:-}
  HOST=${HOST:-}
  DOMAIN=${DOMAIN#http://}
  DOMAIN=${DOMAIN#https://}
  DOMAIN=${DOMAIN%%/*}
  DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')

  valid_port "$PORT" || die "PORT must be 1-65535 (got '$PORT')"
  valid_port "$HTTPS_PORT" || die "HTTPS_PORT must be 1-65535 (got '$HTTPS_PORT')"
  [[ "$MAX_LINES" =~ ^[0-9]+$ ]] || die "MAX_LINES must be a number"
  [[ "$MAX_STREAMS" =~ ^[0-9]+$ ]] || die "MAX_STREAMS must be a number"
  [[ "$ALLOWED_IPS" =~ ^[0-9A-Fa-f.:/,\ ]*$ ]] || die "ALLOWED_IPS may only contain IPs/CIDRs separated by commas"
  if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
    die "DOMAIN must be a hostname like logs.example.com (got '$DOMAIN')"
  fi
  if [ -n "$DOMAIN" ] && [ "$PORT" = "80" -o "$PORT" = "$HTTPS_PORT" ]; then
    die "PORT $PORT clashes with the nginx ports used for the domain. Pick another PORT."
  fi

  if [ "$LOGIN" != "true" ]; then
    AUTH_PASS=
  elif [ -z "$AUTH_PASS" ]; then
    AUTH_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true)
    if grep -q '^AUTH_PASS=' "$CONFIG"; then
      sed -i "s|^AUTH_PASS=.*|AUTH_PASS=$AUTH_PASS|" "$CONFIG"
    else
      echo "AUTH_PASS=$AUTH_PASS" >>"$CONFIG"
    fi
    say "Generated a random password (saved in config.env)"
  fi

  if [ -z "$HOST" ]; then
    if [ -n "$DOMAIN" ]; then HOST=127.0.0.1; else HOST=0.0.0.0; fi
  fi
}

valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

ensure_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker first: https://docs.docker.com/engine/install/"
}

ensure_node() {
  local need=1 v
  if command -v node >/dev/null 2>&1; then
    v=$(node -p 'process.versions.node.split(".")[0]')
    [ "$v" -ge 18 ] && need=0
  fi
  [ "$need" -eq 0 ] && return
  say "Installing Node.js 20"
  if command -v apt-get >/dev/null 2>&1; then
    apt_update_once
    apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    pkg_install nodejs
  else
    die "Unsupported package manager. Install Node.js 18+ manually."
  fi
}

ensure_nginx() {
  command -v nginx >/dev/null 2>&1 && return
  say "Installing nginx"
  apt_update_once
  pkg_install nginx
}

ensure_certbot() {
  command -v certbot >/dev/null 2>&1 && return
  say "Installing certbot"
  apt_update_once
  if command -v apt-get >/dev/null 2>&1; then
    pkg_install certbot
  else
    pkg_install epel-release >/dev/null 2>&1 || true
    pkg_install certbot
  fi
}

ensure_dns_tools() {
  command -v dig >/dev/null 2>&1 && return
  apt_update_once
  if command -v apt-get >/dev/null 2>&1; then pkg_install dnsutils >/dev/null 2>&1 || true
  else pkg_install bind-utils >/dev/null 2>&1 || true; fi
}

server_ips() {
  {
    curl -fsS -m 5 -4 https://api.ipify.org 2>/dev/null || true
    echo
    curl -fsS -m 5 -6 https://api64.ipify.org 2>/dev/null || true
    echo
    hostname -I 2>/dev/null | tr ' ' '\n'
  } | grep -v "^$" | sort -u || true
}

domain_ips() {
  local d=$1
  if command -v dig >/dev/null 2>&1; then
    { dig +short A "$d" @1.1.1.1; dig +short AAAA "$d" @1.1.1.1; } 2>/dev/null | grep -E '^[0-9a-fA-F:.]+$' | grep -E '[.:]' || true
  else
    getent ahosts "$d" 2>/dev/null | awk '{print $1}' | sort -u || true
  fi
}

DNS_OK=0
check_dns() {
  DNS_OK=0
  if [ "$SKIP_DNS_CHECK" = "true" ]; then DNS_OK=1; warn "Skipping DNS check (SKIP_DNS_CHECK=true)"; return; fi
  ensure_dns_tools
  say "Checking that $DOMAIN points to this server"
  local mine theirs
  mine=$(server_ips)
  theirs=$(domain_ips "$DOMAIN")
  if [ -z "$theirs" ]; then
    warn "$DOMAIN does not resolve to any IP yet."
    echo "    Create an A record:  $DOMAIN  ->  $(echo "$mine" | grep -m1 -E '^[0-9.]+$' || echo '<this server IP>')"
    return
  fi
  local ip match=0
  for ip in $theirs; do
    if echo "$mine" | grep -qxF "$ip"; then match=1; fi
  done
  echo "    $DOMAIN resolves to: $(echo $theirs)"
  echo "    This server's IPs:   $(echo $mine)"
  if [ "$match" -eq 1 ]; then
    DNS_OK=1
    say "DNS OK"
  else
    warn "$DOMAIN does not point to this server."
    echo "    Set the A record of $DOMAIN to $(echo "$mine" | grep -m1 -E '^[0-9.]+$' || echo 'this server IP')."
    echo "    If you use Cloudflare, set the record to 'DNS only' (grey cloud) while the certificate is issued,"
    echo "    or set SKIP_DNS_CHECK=true in config.env if you know the proxy forwards port 80 here."
  fi
}

port_owner() { ss -ltnpH "( sport = :$1 )" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | sed 's/users:(("//; s/"$//' || true; }

check_ports_free() {
  local p owner
  for p in 80 "$HTTPS_PORT"; do
    owner=$(port_owner "$p")
    if [ -n "$owner" ] && [ "$owner" != "nginx" ]; then
      die "Port $p is already used by '$owner' (maybe a Docker container). nginx needs it for the domain. Free it or set HTTPS_PORT to another port."
    fi
  done
}

systemd_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'; }

write_unit() {
  local node_bin
  node_bin=$(command -v node)
  cat >"$UNIT" <<UNIT
[Unit]
Description=Docker Logs Viewer
After=docker.service network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$node_bin $APP_DIR/server.js
Environment="PORT=$PORT"
Environment="HOST=$(systemd_escape "$HOST")"
Environment="AUTH_USER=$(systemd_escape "$AUTH_USER")"
Environment="AUTH_PASS=$(systemd_escape "$AUTH_PASS")"
Environment="MAX_LINES=$MAX_LINES"
Environment="MAX_STREAMS=$MAX_STREAMS"
Environment="ALLOWED_IPS=$ALLOWED_IPS"
Environment="TRUST_PROXY=$([ -n "$DOMAIN" ] && echo true || echo false)"
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
UNIT
  chmod 600 "$UNIT"
}

proxy_block() {
  cat <<PROXY
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
        gzip off;
    }
PROXY
}

acme_block() {
  cat <<ACME
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_ROOT;
        default_type text/plain;
    }
ACME
}

cert_dir() { echo "/etc/letsencrypt/live/$DOMAIN"; }
have_cert() { [ -s "$(cert_dir)/fullchain.pem" ] && [ -s "$(cert_dir)/privkey.pem" ]; }

write_nginx_http() {
  {
    echo "server {"
    echo "    listen 80;"
    echo "    listen [::]:80;"
    echo "    server_name $DOMAIN;"
    acme_block
    proxy_block
    echo "}"
  } >"$NGINX_CONF"
}

write_nginx_https() {
  local redirect="https://\$host\$request_uri"
  [ "$HTTPS_PORT" != "443" ] && redirect="https://\$host:$HTTPS_PORT\$request_uri"
  {
    echo "server {"
    echo "    listen 80;"
    echo "    listen [::]:80;"
    echo "    server_name $DOMAIN;"
    acme_block
    echo "    location / { return 301 $redirect; }"
    echo "}"
    echo
    echo "server {"
    echo "    listen $HTTPS_PORT ssl;"
    echo "    listen [::]:$HTTPS_PORT ssl;"
    echo "    http2 on;"
    echo "    server_name $DOMAIN;"
    echo "    ssl_certificate $(cert_dir)/fullchain.pem;"
    echo "    ssl_certificate_key $(cert_dir)/privkey.pem;"
    echo "    ssl_protocols TLSv1.2 TLSv1.3;"
    echo "    ssl_session_cache shared:dlv:10m;"
    echo "    add_header Strict-Transport-Security \"max-age=31536000\" always;"
    proxy_block
    echo "}"
  } >"$NGINX_CONF"
  if ! nginx -t >/dev/null 2>&1; then
    sed -i '/http2 on;/d; s/listen \(\[::\]:\)\?\([0-9]*\) ssl;/listen \1\2 ssl http2;/' "$NGINX_CONF"
  fi
}

reload_nginx() {
  nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx config test failed"; }
  systemctl enable nginx >/dev/null 2>&1 || true
  if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl restart nginx; fi
}

check_http_reachable() {
  local token
  token=$(tr -dc 'a-z0-9' </dev/urandom | head -c 24 || true)
  mkdir -p "$ACME_ROOT/.well-known/acme-challenge"
  echo "$token" >"$ACME_ROOT/.well-known/acme-challenge/$token"
  local got
  got=$(curl -fsS -m 10 "http://$DOMAIN/.well-known/acme-challenge/$token" 2>/dev/null || true)
  rm -f "$ACME_ROOT/.well-known/acme-challenge/$token"
  [ "$got" = "$token" ]
}

issue_cert() {
  ensure_certbot
  if ! check_http_reachable; then
    warn "http://$DOMAIN is not reachable on port 80 from this server. Let's Encrypt may fail."
    echo "    Make sure port 80 is open in your VPS provider's firewall / security group."
  fi
  say "Requesting Let's Encrypt certificate for $DOMAIN"
  local email_args=(--register-unsafely-without-email)
  [ -n "$CERTBOT_EMAIL" ] && email_args=(-m "$CERTBOT_EMAIL")
  certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" \
    --non-interactive --agree-tos --keep-until-expiring "${email_args[@]}" \
    --deploy-hook "systemctl reload nginx"
}

configure_domain() {
  if [ -z "$DOMAIN" ]; then
    if [ -f "$NGINX_CONF" ]; then
      rm -f "$NGINX_CONF"
      systemctl reload nginx 2>/dev/null || true
      say "Removed old domain config"
    fi
    return
  fi

  command -v ss >/dev/null 2>&1 && check_ports_free
  check_dns
  ensure_nginx
  mkdir -p "$ACME_ROOT"

  if [ "$DOMAIN_HTTPS" = "false" ]; then
    write_nginx_http
    reload_nginx
    return
  fi

  if have_cert; then
    write_nginx_https
    reload_nginx
  else
    write_nginx_http
    reload_nginx
  fi

  if [ "$DNS_OK" -eq 1 ]; then
    if issue_cert; then
      write_nginx_https
      reload_nginx
      say "HTTPS enabled (auto-renewal is handled by certbot's timer)"
    else
      warn "Certificate request failed. The site is served over plain HTTP for now."
      echo "    Fix the issue above and re-run: sudo bash start.sh"
    fi
  elif ! have_cert; then
    warn "Skipped HTTPS because DNS is not pointing here yet. Serving http://$DOMAIN for now."
    echo "    Re-run 'sudo bash start.sh' once DNS has updated to get a certificate."
  fi
}

open_port() {
  local p=$1
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$p/tcp" >/dev/null
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port="$p/tcp" >/dev/null && firewall-cmd --reload >/dev/null
  fi
}

configure_firewall() {
  if [ -n "$DOMAIN" ]; then
    open_port 80
    [ "$DOMAIN_HTTPS" != "false" ] && open_port "$HTTPS_PORT"
  fi
  if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ]; then open_port "$PORT"; fi
}

public_url() {
  if [ -n "$DOMAIN" ]; then
    if [ "$DOMAIN_HTTPS" != "false" ] && have_cert; then
      if [ "$HTTPS_PORT" = "443" ]; then echo "https://$DOMAIN"; else echo "https://$DOMAIN:$HTTPS_PORT"; fi
    else
      echo "http://$DOMAIN"
    fi
  else
    local ip
    ip=$(curl -fsS -m 5 -4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
    echo "http://$ip:$PORT"
  fi
}

cmd_start() {
  load_config
  ensure_docker
  command -v curl >/dev/null 2>&1 || { apt_update_once; pkg_install curl; }
  ensure_node
  write_unit
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"
  sleep 1
  systemctl is-active --quiet "$SERVICE" || die "Service failed to start. Check: journalctl -u $SERVICE -n 50"
  configure_domain
  configure_firewall
  echo
  say "Docker Logs Viewer is running"
  echo "    URL:   $(public_url)"
  if [ -n "$AUTH_PASS" ]; then
    echo "    Login: $AUTH_USER / $AUTH_PASS"
  else
    echo "    Login: off (LOGIN=false)"
    if [ -z "$ALLOWED_IPS" ]; then
      warn "Anyone who knows this URL can read all container logs. Set ALLOWED_IPS or LOGIN=true in config.env to restrict it."
    else
      echo "    Allowed IPs: $ALLOWED_IPS"
    fi
  fi
  echo "    Edit config.env and re-run 'sudo bash start.sh' to apply changes."
}

cmd_check_dns() {
  load_config
  [ -n "$DOMAIN" ] || die "No DOMAIN set in config.env"
  check_dns
}

cmd_uninstall() {
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  if [ -f "$NGINX_CONF" ]; then rm -f "$NGINX_CONF"; systemctl reload nginx 2>/dev/null || true; fi
  say "Uninstalled service (repo folder, config.env and any certificates left in place)"
}

case "${1:-start}" in
  start|restart|install) cmd_start ;;
  stop) systemctl stop "$SERVICE"; say "Stopped" ;;
  status) systemctl status "$SERVICE" --no-pager ;;
  logs) journalctl -u "$SERVICE" -f ;;
  check-dns) cmd_check_dns ;;
  uninstall) cmd_uninstall ;;
  *) echo "Usage: sudo bash start.sh [start|stop|restart|status|logs|check-dns|uninstall]"; exit 1 ;;
esac
