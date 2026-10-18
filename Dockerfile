# Paths mirror the repo layout under /app: the server resolves fixtures/ via the
# compile-time CARGO_MANIFEST_DIR (/app/server), so build and runtime must agree.

FROM rust:1-bookworm AS server
WORKDIR /app/server
COPY server/ ./
RUN cargo build --release

FROM node:22-bookworm-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=server /app/server/target/release/do-server /app/server/do-server
COPY server/fixtures /app/server/fixtures
COPY data /app/data
COPY --from=client /app/client/dist /app/client/dist
ENV PORT=8080 DATA_DIR=/app/data DIST_DIR=/app/client/dist RUST_LOG=info
EXPOSE 8080
CMD ["/app/server/do-server"]
