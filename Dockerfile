FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
RUN useradd -r -u 10001 underwright
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json ./
ENV UNDERWRIGHT_DB=/data/underwright.db
VOLUME /data
USER underwright
EXPOSE 8741
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--http", "0.0.0.0:8741"]
