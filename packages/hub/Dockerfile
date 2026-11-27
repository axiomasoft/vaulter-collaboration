# Vaulter collaboration hub — a reusable, env-configured external image
# (master plan Addendum A). One published image serves many projects; consumers
# reference it via `image: ghcr.io/axiomasoft/vaulter-collaboration-hub:<ver>` and configure
# it through environment variables only — no sources copied, no secrets baked.
#
# syntax=docker/dockerfile:1
# Debian-slim base: musl/alpine's npm hits "Exit handler never called" on `npm ci`; the
# deps are pure-JS so glibc-vs-musl is irrelevant, and slim stays small + non-root.
ARG NODE_VERSION=26.13.1-slim

# ── deps: reproducible production install from the committed lockfile ────────────────
FROM node:${NODE_VERSION}@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && node -e "process.exit(0)"
WORKDIR /app
COPY package.json package-lock.json ./
# --no-audit/--no-fund avoid the post-install network steps that can crash alpine's npm
# ("Exit handler never called"); --omit=dev keeps the runtime image lean.
RUN npm ci --omit=dev --no-audit --no-fund

# ── runtime: minimal, non-root ──────────────────────────────────────────────────────
FROM node:${NODE_VERSION}@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && node -e "process.exit(0)"
WORKDIR /app

# Secure default: the published image runs as production, so the hub demands an explicit
# Origin allowlist (CSWSH) and backend URL rather than booting open (see config.js). The
# management listener (/livez, /readyz, /metrics) binds loopback: the HEALTHCHECK below runs inside
# the container; set VAULTER_COLLAB_MANAGEMENT_HOST=0.0.0.0 only for probes from outside it (a
# Kubernetes kubelet, a Prometheus scrape) and never route a public ingress to that port.
ENV NODE_ENV=production \
    VAULTER_COLLAB_PORT=1234 \
    VAULTER_COLLAB_MANAGEMENT_HOST=127.0.0.1 \
    VAULTER_COLLAB_MANAGEMENT_PORT=1235

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Run as the unprivileged built-in `node` user (never root).
USER node

EXPOSE 1234

# SIGTERM drains the hub (src/shutdown.js): writes stop, the pending ledger flushes for up to
# VAULTER_COLLAB_SHUTDOWN_FLUSH_MS (25 s), then destroy() for up to VAULTER_COLLAB_SHUTDOWN_DESTROY_MS
# (5 s), persistence stop (8 s) and listener close (1 s) — give `docker stop -t` / terminationGracePeriodSeconds >= 40 s.
STOPSIGNAL SIGTERM

# Liveness for compose/orchestrator: /livez of the management listener (never the WS port). It
# depends on nothing but the event loop; readiness is /readyz.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const h=process.env.VAULTER_COLLAB_MANAGEMENT_HOST;const host=!h||h==='0.0.0.0'||h==='::'?'127.0.0.1':h;fetch('http://'+host+':'+(process.env.VAULTER_COLLAB_MANAGEMENT_PORT||1235)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

LABEL org.opencontainers.image.title="Vaulter Hocuspocus hub" \
      org.opencontainers.image.description="Reusable, env-configured Hocuspocus collaboration server for Vaulter (Yjs realtime document editing)." \
      org.opencontainers.image.source="https://github.com/axiomasoft/vaulter-collaboration" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary"

# The hub's command line (src/cli.js, package bin vaulter-collaboration-hub). By default the image
# serves (WebSocket hub + compaction worker); the same image runs the offline recovery one-shot:
#   docker run --rm --env-file hub.env <image> compact --pending --deadline=120
# (exit 0: nothing left to compact; 1: the pending documents are listed on stderr).
ENTRYPOINT ["node", "src/cli.js"]
CMD ["serve"]
