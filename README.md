# Docker Logs Viewer

A small web UI for watching the logs of every Docker container on your VPS: live streaming, full history ("all"), search, level filter, coloured output and dark / black / white themes. It works on desktop and mobile browsers.

## Install

On the VPS (Ubuntu / Debian / RHEL-family, with Docker already installed):

```bash
git clone https://github.com/kagut57/docker-logs-viewer.git
cd docker-logs-viewer
sudo bash start.sh
```

On first run `start.sh` will:

- create `config.env` from `config.example.env`
- install Node.js 20 if Node 18+ is missing
- install and start a systemd service (`docker-logs-viewer`) that restarts on boot
- open the port in `ufw` / `firewalld` if one is active
- print the URL

Your cloud provider's firewall or security group still has to allow the port.

## Configuration

Edit `config.env`, then run `sudo bash start.sh` again to apply it.

| Key | Default | Meaning |
| --- | --- | --- |
| `PORT` | `6060` | Port the app listens on |
| `LOGIN` | `false` | Require a username/password (`AUTH_USER` / `AUTH_PASS`, random if empty) |
| `ALLOWED_IPS` | empty | Only allow these IPs / CIDR ranges (comma separated) |
| `MAX_STREAMS` | `20` | Max simultaneous log streams |
| `DOMAIN` | empty | Custom domain, e.g. `logs.example.com` |
| `CERTBOT_EMAIL` | empty | Email for Let's Encrypt expiry notices |
| `DOMAIN_HTTPS` | `true` | Set `false` to serve the domain over plain HTTP |
| `HTTPS_PORT` | `443` | Public HTTPS port for the domain |
| `SKIP_DNS_CHECK` | `false` | Skip the "domain points here" check (e.g. behind a Cloudflare proxy) |
| `HOST` | auto | Bind address; `127.0.0.1` when a domain is set, otherwise `0.0.0.0` |
| `MAX_LINES` | `100000` | Lines kept in the browser per container; the oldest are dropped past this |

### Custom domain + HTTPS

1. Create a DNS **A record** for your domain that points to the VPS IP.
2. Set `DOMAIN=logs.example.com` (and optionally `CERTBOT_EMAIL`) in `config.env`.
3. Run `sudo bash start.sh`.

The script then:

- checks that the domain resolves to this server's IP, and tells you what to fix if it doesn't
- checks that ports 80/443 are not used by something else (such as another container)
- installs nginx as a reverse proxy and binds the app to `127.0.0.1`
- checks that `http://DOMAIN` reaches this server, then gets a free Let's Encrypt certificate with certbot
- switches the site to HTTPS with an HTTP→HTTPS redirect. Certbot's timer renews the certificate automatically

If DNS is not pointing to the server yet, the site is served over HTTP for now. Re-run `start.sh` once DNS has updated. To check DNS on its own, run `sudo bash start.sh check-dns`.

If you use Cloudflare, set the record to **DNS only** (grey cloud) while the certificate is issued.

## Commands

```bash
sudo bash start.sh            # install / apply config / restart
sudo bash start.sh stop
sudo bash start.sh status
sudo bash start.sh logs       # the viewer's own service logs
sudo bash start.sh check-dns
sudo bash start.sh uninstall  # removes the service and nginx site
```

To update to the latest version:

```bash
git pull && sudo bash start.sh
```

## Features

- Sidebar with every container (running, exited, restarting) and its status
- Live log stream with timestamps. Pick 100 / 200 / 1000 / 5000 / 20000 / **all** lines of history
- Level colouring (ERROR / WARN / INFO / DEBUG), ANSI colour support, and highlighting for HTTP methods, status codes, URLs, numbers and `key=value` pairs
- Filter box with match highlighting, plus a minimum-level filter
- Dark, black (AMOLED) and white themes, saved per browser
- Newest logs on top; older lines load as you scroll down (only a few hundred rows are drawn at a time, so even "all" stays smooth)
- A "new lines" button appears when new logs arrive while you are scrolled down
- Wrap, clear, and download the loaded logs
- Mobile layout with a slide-out container list

## Security

**There is no login by default.** Anyone who has the URL can read the logs of every container, and logs often contain tokens, passwords or database URLs. To restrict access, use one or both of these:

- `ALLOWED_IPS=203.0.113.7,198.51.100.0/24`: only these IPs or ranges can open the site; everyone else gets 403. This also works behind the nginx/domain setup, which checks the real client IP.
- `LOGIN=true`: asks for a username and password (a random password is generated if `AUTH_PASS` is empty).

Built-in protections:

- Read-only: the app only runs `docker ps` and `docker logs`. Every request except GET/HEAD gets 405.
- Container names are strictly validated and passed to Docker without a shell, so no command or flag injection is possible.
- Only `/` and `/api/*` are served, so files like `server.js`, `config.env` and `.git` can't be read (no path traversal).
- Log lines and container names are shown as plain text. A strict Content-Security-Policy allows only the page's own scripts (by hash), so XSS payloads in logs can't run.
- Clickjacking protection (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), `nosniff` and `no-referrer` headers.
- At most `MAX_STREAMS` (20) log streams can be open at once, so nobody can flood the server with `docker logs` processes.
- The systemd service runs with `NoNewPrivileges` and a read-only `/usr`, `/boot` and `/etc`.

It still runs as root to reach the Docker socket, so don't expose it publicly without `ALLOWED_IPS` or `LOGIN=true`.

### Security test

`npm test` runs 41 checks against a fake Docker (no real containers needed): auth on/off, IP allowlist and spoofed headers, path traversal, command/flag injection, write methods, security headers, CSP and the stream-flood limit.
