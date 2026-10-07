# syntax=docker/dockerfile:1
#
# ai-client — the translation-support pipeline as a container.
#
# What this image is: the pipeline, and nothing else. It is a CLIENT of a model server
# (AI_BASE_URL in .env) — it does not serve a model, needs no GPU, and holds no model
# weights. What has to be reachable from inside it is your OpenAI-compatible endpoint.
#
# Build and run it with docker compose (docker-compose.yml explains the folders and the
# environment); the short version is in docs/docker.md.
#
#   docker compose up --build                    # the whole pipeline, one step at a time
#   docker compose run --rm pipeline --list      # just the step list
#   docker compose run --rm --entrypoint bash pipeline   # a shell inside the image

FROM node:22-bookworm-slim

# gulp is listed under devDependencies, but index.js runs every pipeline step through
# it (index/settings.js: gulpCommand()), so the image installs the whole dependency
# tree, not the production half.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app/ai-client

# Dependencies first, so a code-only change reuses this layer instead of reinstalling
# the world.
COPY package.json package-lock.json ./
RUN npm ci

# The application. .dockerignore is what keeps your books, your keys and this machine's
# run history out of the image.
COPY . .

# The folders the pipeline writes: the default source folder (SERIES_LOCATION when unset),
# the run transcripts (.logs/), the step runner's machine state (.postmortem/), the prompt
# dumps (--dry-run), and the token-calibration cache. Created here so a fresh clone works
# before anything is mounted, owned by the unprivileged user the container runs as, and left
# open to any user so that running the container as YOUR uid (what docker-compose.yml does)
# can still write them.
RUN mkdir -p epub_source .logs .postmortem .dry-run .cache \
    && chown -R node:node /app/ai-client \
    && chmod 0777 epub_source .logs .postmortem .dry-run .cache

USER node

# The pipeline, one step at a time (the same command as `npm run pipeline`). Every flag
# index.js and gulp accept goes after it:
#
#   docker run --rm ai-client --stages=glossary,jump-in-wiki
#   docker run --rm ai-client --volume 03 --force
#   docker run --rm ai-client --dry-run
ENTRYPOINT ["node", "index.js"]
