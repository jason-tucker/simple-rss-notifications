# Outer ingress image: Caddy + a minimal fallback landing page.
# The Next.js app is a separate image built from web/Dockerfile.
# Base image pinned to a specific patch tag (not floating `2.10-alpine`) so a
# rebuild can't silently swap the base out. Bump deliberately. Follow-up: pin
# by `@sha256:` digest + verify with cosign once a digest can be resolved in CI.
FROM caddy:2.10.0-alpine

# Bake the fallback landing page and Caddyfile into the image so a single
# `docker compose pull` is enough to deploy a new build.
COPY landing/ /srv/landing/
COPY Caddyfile /etc/caddy/Caddyfile

ARG GIT_SHA=dev
ARG BUILD_TIME=unknown
RUN sed -i \
  -e "s|</head>|<meta name=\"build-sha\" content=\"${GIT_SHA}\"><meta name=\"build-time\" content=\"${BUILD_TIME}\"></head>|" \
  /srv/landing/502.html 2>/dev/null || true

EXPOSE 6082
