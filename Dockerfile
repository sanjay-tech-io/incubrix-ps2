# One image for api, worker, init and tests (Node 22, ffmpeg for the media tools, espeak-ng to synthesize the AI-generated speech in the test clips).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/engine/package.json packages/engine/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
COPY packages/media/package.json packages/media/
COPY packages/errors/package.json packages/errors/
COPY packages/nlu/package.json packages/nlu/
COPY packages/store/package.json packages/store/
COPY packages/render/package.json packages/render/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
RUN npm ci
COPY . .
