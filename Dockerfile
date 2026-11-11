# AgentAgency application image — cloud-neutral, runs on any Linux host with Docker
# (OCI, AWS EC2, Azure VM, GCP Compute Engine, VPS, on-prem). Multi-arch: linux/amd64, linux/arm64.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG INSTALL_DOCKER_CLI=false
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG GEMINI_CLI_VERSION=latest
# Cursor Agent CLI is installed from Cursor's official installer only when requested.
ARG INSTALL_CURSOR_CLI=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini curl \
 && if [ "$INSTALL_DOCKER_CLI" = "true" ]; then apt-get install -y --no-install-recommends docker.io; fi \
 && rm -rf /var/lib/apt/lists/*
# Official subscription CLIs (logged in by the operator with `claude auth login` / `codex login`).
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" "@google/gemini-cli@${GEMINI_CLI_VERSION}" --no-audit --no-fund \
 && npm cache clean --force
RUN groupadd -g 1000 -o agent && useradd -m -u 1000 -g 1000 -o -s /bin/bash agent || true
WORKDIR /app
COPY --from=build --chown=agent:agent /app/node_modules ./node_modules
COPY --from=build --chown=agent:agent /app/dist ./dist
COPY --chown=agent:agent package.json ./
# `agent-agency setup` / `agent-agency config` inside the container (./aa wraps these).
RUN chmod +x /app/dist/cli.js && ln -sf /app/dist/cli.js /usr/local/bin/agent-agency
RUN mkdir -p /data /home/agent/.claude /home/agent/.codex /home/agent/.gemini /home/agent/.cursor /home/agent/.config/cursor /home/agent/.local/bin && chown -R 1000:1000 /data /home/agent
USER 1000:1000
# The node base image already has uid 1000 ("node", home /home/node). Pin HOME explicitly so CLI
# logins (~/.claude, ~/.codex, ~/.gemini, ~/.cursor, ~/.config/cursor) land in the mounted volumes and survive rebuilds.
ENV HOME=/home/agent
RUN if [ "$INSTALL_CURSOR_CLI" = "true" ]; then curl -fsS https://cursor.com/install | bash; fi
ENV PATH="/home/agent/.local/bin:${PATH}"
ENV NODE_ENV=production \
    AA_DATA_DIR=/data \
    AA_WEB_PORT=8080 \
    AA_WEB_BIND=0.0.0.0
EXPOSE 8080
VOLUME ["/data", "/home/agent/.claude", "/home/agent/.codex", "/home/agent/.gemini", "/home/agent/.cursor"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD curl -fsS --noproxy '*' http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli.js"]
CMD ["start"]
