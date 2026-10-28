FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY deploy ./deploy
RUN npm run build && chmod +x /app/deploy/entrypoint.sh
ENV COMPETE_DATA_DIR=/data
VOLUME ["/data"]
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
