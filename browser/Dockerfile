# Applaud browser: an always-on Chromium for Automatic Plaud sync
# (Settings → Automatic Plaud sync; docs/portainer.md). It runs the Applaud
# *automation* extension, a separate build from the desktop extension, which
# sends confirmed speaker names to Plaud and fetches summary cards.
#
# Build from the repository root:
#   docker build -f browser/Dockerfile -t applaud-browser .

# --- Build stage: the automation extension ---
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Manifests only, so the lockfile matches; their dependencies aren't installed.
COPY server/package.json server/
COPY web/package.json web/
COPY shared/ shared/
COPY extension/ extension/

RUN pnpm install --frozen-lockfile --filter "@applaud/extension..."
RUN pnpm --filter @applaud/shared build && pnpm -C extension build:automation

# --- Runtime: Chromium on a virtual display, viewed in a web page (KasmVNC) ---
# Pinned by tag and digest; bump both together after checking the release notes.
FROM lscr.io/linuxserver/chromium:075b0b99-ls64@sha256:6d2a8da6a45d4083a7287211a619ca29fdb518ebea0ef562c27392ba2f6698d2

COPY --from=build /app/extension/dist-automation/ /opt/applaud-automation/
COPY browser/root/ /

# Chromium (unlike branded Chrome 137+) still loads an unpacked extension from
# the command line. Its id comes from this fixed path, so its storage survives
# image updates. Applaud's credential arrives in /opt/applaud-automation/secret
# from the volume shared with Applaud (mounted read-only).
ENV CHROME_CLI="--load-extension=/opt/applaud-automation --disable-extensions-except=/opt/applaud-automation https://web.plaud.ai/"
