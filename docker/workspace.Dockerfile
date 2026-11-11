# Per-project isolated development workspace (AA_WORKSPACE_MODE=docker).
# Runs as non-root with dropped capabilities, CPU/RAM/pid limits applied by the orchestrator.
# Extend this image with the toolchains your projects need; keep it versioned in Git.
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip python3-venv build-essential curl \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" --no-audit --no-fund && npm cache clean --force
RUN groupadd -g 1000 -o agent && useradd -m -u 1000 -g 1000 -o -s /bin/bash agent || true
USER 1000:1000
ENV HOME=/home/agent CI=true
WORKDIR /workspace
CMD ["sleep", "infinity"]
