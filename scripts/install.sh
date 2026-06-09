#!/usr/bin/env bash
# simple-rss-notifications — VPS install/update script.
#
# One-shot install (replace OWNER):
#   GITHUB_OWNER=OWNER bash <(curl -fsSL https://raw.githubusercontent.com/OWNER/simple-rss-notifications/main/scripts/install.sh)
#
# What this does:
#   1. Checks Docker + Docker Compose v2.
#   2. Clones or updates the repo to ~/projects/simple-rss-notifications.
#   3. Creates .env from .env.example with auto-generated secrets
#      (POSTGRES_PASSWORD, SESSION_SECRET, APP_ENCRYPTION_KEY, BOOTSTRAP_PASSWORD).
#   4. Opens .env in nano so you can fill in PUBLIC_BASE_URL.
#   5. Pulls the latest GHCR image.
#   6. Starts the stack via `docker compose up -d`.

set -Eeuo pipefail

APP_NAME="simple-rss-notifications"
GITHUB_OWNER="${GITHUB_OWNER:-}"
BRANCH="${BRANCH:-main}"
PROJECT_DIR="${PROJECT_DIR:-$HOME/projects/$APP_NAME}"
MIN_DOCKER_MAJOR=24

if [ -t 1 ]; then
    GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
else
    GREEN=''; YELLOW=''; RED=''; BLUE=''; NC=''
fi
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
info() { printf "${BLUE}▶${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
err()  { printf "${RED}✗${NC} %s\n" "$*" >&2; }

# Generate 32 random bytes as 64 hex chars. Works without openssl as fallback.
gen_hex64() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        head -c 32 /dev/urandom | xxd -p -c 64
    fi
}

# Generate a URL-safe alphanumeric password (DATABASE_URL must parse cleanly).
gen_alnum() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 24
    else
        head -c 64 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32
    fi
}

# ── Step 1: Docker ────────────────────────────────────────────────────────────
info "Checking Docker..."
if ! command -v docker >/dev/null 2>&1; then
    err "Docker is not installed."
    cat <<EOF
Install Docker first:
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker \$USER
    newgrp docker
Then rerun this script.
EOF
    exit 1
fi

DOCKER_VER=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "")
if [ -z "$DOCKER_VER" ]; then
    err "Docker is installed but the daemon is not accessible."
    echo "  Try: sudo systemctl start docker"
    echo "  Or:  groups | grep docker"
    exit 1
fi

DOCKER_MAJOR=$(echo "$DOCKER_VER" | cut -d. -f1)
if [ "$DOCKER_MAJOR" -lt "$MIN_DOCKER_MAJOR" ]; then
    warn "Docker $DOCKER_VER older than recommended ($MIN_DOCKER_MAJOR.x+). Continuing."
else
    ok "Docker $DOCKER_VER"
fi

if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose v2 plugin is not installed."
    echo "  Debian/Ubuntu: sudo apt install -y docker-compose-plugin"
    exit 1
fi
ok "Docker Compose $(docker compose version --short 2>/dev/null || echo '?')"

# ── Step 2: Clone or update ──────────────────────────────────────────────────
if [ ! -d "$PROJECT_DIR" ]; then
    if [ -z "$GITHUB_OWNER" ]; then
        read -rp "GitHub owner/username for $APP_NAME: " GITHUB_OWNER
    fi
    info "Cloning $APP_NAME to $PROJECT_DIR..."
    mkdir -p "$(dirname "$PROJECT_DIR")"
    git clone -b "$BRANCH" "https://github.com/$GITHUB_OWNER/$APP_NAME.git" "$PROJECT_DIR"
else
    info "Updating $PROJECT_DIR..."
    cd "$PROJECT_DIR"
    git fetch --all
    git reset --hard "origin/$BRANCH"
fi

cd "$PROJECT_DIR"

if [ -z "$GITHUB_OWNER" ]; then
    GITHUB_OWNER=$(git config --get remote.origin.url | sed -E 's|.*[:/]([^/]+)/[^/]+\.git|\1|')
fi
OWNER_LC="${GITHUB_OWNER,,}"
WEB_IMAGE="ghcr.io/${OWNER_LC}/${APP_NAME}-web:latest"
CADDY_IMAGE="ghcr.io/${OWNER_LC}/${APP_NAME}:latest"

# ── Step 3: .env ─────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    info "Creating .env from .env.example..."
    cp .env.example .env

    # Image tags
    sed -i "s|^WEB_IMAGE=.*|WEB_IMAGE=$WEB_IMAGE|" .env
    sed -i "s|^CADDY_IMAGE=.*|CADDY_IMAGE=$CADDY_IMAGE|" .env

    # Auto-generate Postgres password
    PG_PW=$(gen_alnum)
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PG_PW|" .env
    ok "Generated random POSTGRES_PASSWORD"

    # Auto-generate SESSION_SECRET
    SS=$(gen_hex64)
    sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SS|" .env
    ok "Generated random SESSION_SECRET (64 hex chars)"

    # Auto-generate APP_ENCRYPTION_KEY
    EK=$(gen_hex64)
    sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$EK|" .env
    ok "Generated random APP_ENCRYPTION_KEY (64 hex chars)"

    # Auto-generate the first-login admin password. There is NO default — the
    # worker refuses to seed an admin with an unset/empty or 'admin' password.
    BOOTSTRAP_PW=$(gen_alnum)
    sed -i "s|^BOOTSTRAP_PASSWORD=.*|BOOTSTRAP_PASSWORD=$BOOTSTRAP_PW|" .env
    ok "Generated random BOOTSTRAP_PASSWORD"
    echo ""
    warn "FIRST-LOGIN ADMIN CREDENTIALS — shown only once, save them now:"
    echo "    username: ${BOOTSTRAP_USERNAME:-tucker}"
    echo "    password: $BOOTSTRAP_PW"
    echo "    (you'll be forced to change this password on first login)"
    echo ""

    warn "Edit .env now and fill in:"
    echo "    PUBLIC_BASE_URL  — e.g. https://feeds.example.com"
    echo "    BOOTSTRAP_USERNAME  — first-login admin username (default tucker)"
    echo ""
    echo "    File: $PROJECT_DIR/.env"
    echo ""
    read -rp "Press ENTER to open .env in nano (Ctrl-O save, Ctrl-X exit)..."
    ${EDITOR:-nano} .env
else
    ok ".env already exists — leaving it alone."
fi

# ── Step 4: Pull image ───────────────────────────────────────────────────────
info "Pulling Docker images..."
if ! docker compose pull 2>&1; then
    err "Image pull failed. Either:"
    echo "  - The image isn't published yet (push to main triggers a build), or"
    echo "  - The image is private and you need: docker login ghcr.io"
    echo ""
    read -rp "Build locally instead? (uses lots of RAM) [y/N] " BUILD_LOCAL
    if [[ "$BUILD_LOCAL" =~ ^[Yy] ]]; then
        docker compose build
    else
        exit 1
    fi
fi

# ── Step 5: Start ────────────────────────────────────────────────────────────
info "Starting $APP_NAME stack..."
docker compose up -d --remove-orphans

info "Waiting for containers to come up..."
sleep 8

if docker compose ps web 2>/dev/null | grep -qE "running|Up"; then
    ok "$APP_NAME is running"
    echo ""
    docker compose ps
    echo ""
    info "Useful commands:"
    echo "    docker compose logs -f web        # web logs"
    echo "    docker compose logs -f worker     # worker logs"
    echo "    docker compose ps                 # status"
    echo "    docker compose restart            # restart (won't re-read .env)"
    echo "    docker compose up -d              # apply .env changes"
    echo ""
    ok "Setup complete. App is reachable on 127.0.0.1:${PORT:-6082} — point cloudflared at that."
else
    err "$APP_NAME failed to start. Recent logs:"
    docker compose logs web --tail=30
    exit 1
fi
