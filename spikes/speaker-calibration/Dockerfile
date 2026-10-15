# Throwaway Phase 0 calibration image. Run on the Portainer host, not the NAS.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# WeSpeaker VoxCeleb ResNet34 (large-margin fine-tuned), pinned by checksum.
ARG MODEL_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx
ARG MODEL_SHA256=e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012
RUN curl -fsSL -o /app/model.onnx "$MODEL_URL" \
  && echo "$MODEL_SHA256  /app/model.onnx" | sha256sum -c -

COPY calibrate.mjs ./
USER node
CMD ["node", "calibrate.mjs"]
