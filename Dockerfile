FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-impress poppler-utils fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY deploy ./deploy
RUN npm run build && chmod +x /app/deploy/entrypoint.sh
# 可选 Agent 运行时，例如 --build-arg AGENT_RUNTIMES="claude-code opencode"
ARG AGENT_RUNTIMES=""
ENV COMPETE_RUNTIME_DIR=/app/runtimes
RUN for r in $AGENT_RUNTIMES; do node dist/cli.js runtime-install "$r"; done
ENV COMPETE_DATA_DIR=/data
VOLUME ["/data"]
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
