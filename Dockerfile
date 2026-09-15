FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
	--fetch-retries=5 \
	--fetch-retry-mintimeout=2000 \
	--fetch-retry-maxtimeout=60000
COPY src ./src
COPY data ./data

USER node
