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

- create `config.env` from `config.example.env` and generate a random password
- install Node.js 20 if Node 18+ is missing
- install and start a systemd service (`docker-logs-viewer`) that restarts on boot
- open the port in `ufw` / `firewalld` if one is active
- print the URL and login

Your cloud provider's firewall or security group still has to allow the port.

## Configuration

Edit `config.env`, then run `sudo bash start.sh` again to apply it.

| Key | Default | Meaning |
| --- | --- | --- |
| `PORT` | `6060` | Port the app listens on |
| `AUTH_USER` / `AUTH_PASS` | `admin` / random | Login for the web UI |
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
- Wrap, pause auto-scroll, clear, and download the loaded logs
- Mobile layout with a slide-out container list

## Security

- The app runs as root so it can read the Docker socket. Keep `AUTH_PASS` strong, and put the app behind HTTPS (custom domain) when you can.
- `config.env` holds your password. It is git-ignored and `chmod 600`.
