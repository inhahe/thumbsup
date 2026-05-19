# syntax=docker/dockerfile:1.6
#
# Long-term-reproducible image for this thumbsup fork. Pin everything we
# control: Node major version, CUDA, every Python wheel. Models (BLIP,
# EasyOCR, sentence-transformers/all-MiniLM-L6-v2) are baked in so the
# image works without internet access or HuggingFace being around years
# from now.
#
# Build:
#   docker build -t thumbsup-fork .
#
# Run a gallery build (host-mounted input + output):
#   docker run --rm --gpus all \
#     -v /path/to/photos:/in:ro \
#     -v /path/to/site:/out \
#     thumbsup-fork \
#     --input /in --output /out \
#     --theme-path /app/themes/classic/theme \
#     --ai-describe --ai-ocr --ai-embed
#
# Serve a server-mode gallery:
#   docker run --rm --gpus all -p 8000:8000 \
#     -v /path/to/site:/out \
#     thumbsup-fork serve --site /out --port 8000 --host 0.0.0.0
# ---------------------------------------------------------------------------

# CUDA 12.6 runtime + cuDNN. Matches the torch+cu126 wheels we install
# below. The "runtime" variant ships the libraries needed at execution
# time without the dev headers, keeping the image smaller.
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PYTHONUNBUFFERED=1

# System binaries thumbsup uses at runtime, plus the libs OpenCV (which
# easyocr pulls in) needs to load at import time. We deliberately pin
# the apt sources via the Ubuntu 24.04 base image rather than chasing
# rolling versions.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      graphicsmagick imagemagick \
      libimage-exiftool-perl \
      ffmpeg gifsicle zip \
      tesseract-ocr \
      libgl1 libglib2.0-0 \
      python3 python3-venv python3-pip \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# build-essential (above) is needed at npm-install time so node-gyp can
# compile better-sqlite3 from source if no prebuilt binary matches the
# Node version. It adds ~200MB which is dwarfed by torch/CUDA — not
# worth the multi-stage gymnastics to strip it out.

# Node 24 from NodeSource, kept on the same Ubuntu base so glibc matches.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# npm install first, in its own layer — biggest cache benefit on rebuilds.
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Python venv. Putting it on PATH means `python3` and `pip` resolve to
# the venv, so thumbsup's --ai-python / --search-python defaults work
# without any extra flag inside the container.
ENV VENV=/opt/venv
RUN python3 -m venv "$VENV"
ENV PATH="$VENV/bin:$PATH"

# torch + torchvision come from PyTorch's CUDA 12.6 wheel index so their
# ABIs match each other and the CUDA runtime in the base image. Other
# packages from PyPI; all pinned to the versions this fork was developed
# against.
RUN pip install --no-cache-dir --upgrade pip==26.0.1 \
 && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu126 \
       torch==2.11.0+cu126 torchvision==0.26.0+cu126 \
 && pip install --no-cache-dir \
       transformers==5.5.4 \
       pillow==12.2.0 \
       easyocr==1.7.2 \
       sentence-transformers==5.4.0 \
       Whoosh==2.7.4 \
       pytesseract==0.3.13 \
       numpy==2.4.4

# Pre-bake all model weights so the image is fully self-contained.
# - HF_HOME: where transformers + sentence-transformers cache models
# - EASYOCR_MODULE_PATH: where easyocr keeps its detection/recognition models
# These same env vars are set in the final ENV block so the runtime sees them.
ENV HF_HOME=/opt/models/hf \
    EASYOCR_MODULE_PATH=/opt/models/easyocr
RUN mkdir -p "$HF_HOME" "$EASYOCR_MODULE_PATH" \
 && python -c "from transformers import BlipProcessor, BlipForConditionalGeneration; \
              BlipProcessor.from_pretrained('Salesforce/blip-image-captioning-base'); \
              BlipForConditionalGeneration.from_pretrained('Salesforce/blip-image-captioning-base')" \
 && python -c "from sentence_transformers import SentenceTransformer; \
              SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')" \
 && python -c "import easyocr; easyocr.Reader(['en'], gpu=False, model_storage_directory='/opt/models/easyocr')"

# Source code last, so day-to-day code changes don't bust the heavy
# pip/npm/model layers above.
COPY src/ ./src/
COPY bin/ ./bin/
COPY scripts/ ./scripts/
COPY themes/ ./themes/
COPY README.md FORK.md ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Conventional mount points the run examples use. Not required — users
# can mount anywhere and pass --input / --output explicitly.
VOLUME ["/in", "/out"]
EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# Default is the build subcommand with no extra args. Without an
# --input / --output the CLI will print its usage, which is the
# friendliest "you forgot the args" behavior.
CMD ["build"]
