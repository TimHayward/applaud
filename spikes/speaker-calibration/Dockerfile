# Throwaway Phase 0 calibration image. Run on the Portainer host, not the NAS.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Five English speaker-embedding models, each pinned by checksum, compared on the same audio.
ARG BASE=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models
RUN mkdir -p /app/models && cd /app/models \
  && for m in \
    "wespeaker_en_voxceleb_resnet34_LM e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012" \
    "3dspeaker_speech_campplus_sv_en_voxceleb_16k 357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b" \
    "3dspeaker_speech_eres2net_sv_en_voxceleb_16k c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5" \
    "nemo_en_titanet_small ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e" \
    "nemo_en_titanet_large d51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77"; \
  do set -- $m; \
    curl -fsSL -o "$1.onnx" "$BASE/$1.onnx" && echo "$2  $1.onnx" | sha256sum -c - || exit 1; \
  done

COPY calibrate.mjs ./
USER node
CMD ["node", "calibrate.mjs"]
