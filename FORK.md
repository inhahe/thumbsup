# Fork additions

This is a fork of [thumbsup](https://github.com/thumbsup/thumbsup) (MIT,
© Romain Prieto). The `themes/classic/` folder in this tree is also a
fork — of [@thumbsup/theme-classic](https://github.com/thumbsup/theme-classic),
also MIT-licensed. Both upstream `LICENSE` files are preserved unchanged
here (`LICENSE.md` for thumbsup, `themes/classic/LICENSE` for the theme).

Five additions on top of upstream:

1. **AI captions + OCR** for every image (local GPU or CPU, no network),
   cached incrementally.
2. **Hybrid search** with a `search.html` page rendered through your
   theme. BM25 keyword ranking blended with sentence-transformer
   semantic ranking via Reciprocal Rank Fusion. Two backends —
   fully-static (MiniSearch + transformers.js in the browser) or
   server-mode (Whoosh + sentence-transformers in a small Python
   server).
3. **Move detection** — when you reorganise your source folders,
   thumbnails are renamed on disk instead of regenerated, and the AI
   cache survives.
4. **Filename in the lightbox caption + a "Search" link** in the classic
   theme header.
5. **Pinned Docker image** (`Dockerfile`) with CUDA, all Python wheels,
   and all AI model weights baked in — for long-term reproducibility
   even if the upstream dependency graph changes.

Everything is opt-in via flags; with no new flags set, this fork builds
identically to upstream thumbsup.

---

## New CLI flags

```
AI options:
  --ai-describe              Generate a BLIP caption for every image
                             (local, no network)                       [boolean] [default: false]
  --ai-ocr                   Run Tesseract OCR on every image and
                             index the text for search                 [boolean] [default: false]
  --ai-python                Python executable for scripts/ai_describe.py
                                                                       [string]  [default: "python3"]
  --ai-blip-model            HuggingFace model id for BLIP captioning
                                                                       [string]
                                                                       [default: "Salesforce/blip-image-captioning-base"]
  --ai-ocr-engine            OCR backend. easyocr is GPU-capable (CUDA
                             when available, CPU fallback). tesseract
                             is CPU-only with a lighter Python install.
                                                                       [choices: "easyocr", "tesseract"]
                                                                       [default: "easyocr"]
  --ai-embed                 Generate sentence-transformer embeddings of
                             (caption + OCR) per image and ship them
                             with the search index. Adds semantic
                             ranking on top of BM25 keyword search,
                             blended via Reciprocal Rank Fusion.       [boolean] [default: false]
  --ai-embed-model           sentence-transformers model id used at
                             build time. Browser uses the matching
                             Xenova ONNX export (e.g. Xenova/<basename>).
                                                                       [string]
                                                                       [default: "sentence-transformers/all-MiniLM-L6-v2"]

Search options:
  --search-mode              "client" ships a prebuilt MiniSearch index
                             to the browser (fully static).
                             "server" builds a Whoosh index and needs a
                             running Python server.                    [choices: "client", "server"]
                                                                       [default: "client"]
  --search-python            Python executable to build the Whoosh index
                                                                       [string]  [default: "python3"]
  --search-build-procs       Whoosh: parallel indexing processes (server
                             mode). Useful when bulk-adding tens of
                             thousands of new docs.                    [number]  [default: 1]
  --search-build-multisegment  Whoosh: skip segment merge on commit.
                             Faster builds for huge galleries; slightly
                             slower searches until you optimize.       [boolean] [default: false]
```

There are no new flags for **move detection** (always on) or for the
**lightbox-caption filename** in the classic theme (always on if you use
`themes/classic/theme` as your `--theme-path`).

---

## Quick start

> In every example below, `./photos` and `./site` are **placeholders**.
> Replace them with your actual paths — don't add a second `--input` /
> `--output` after them. yargs crashes with `Cannot redefine property`
> if the same single-value flag appears twice.

### Just the gallery — same as upstream

```bash
thumbsup --input ./photos --output ./site
```

### With AI captions + OCR + semantic search

```bash
# 1) one-time setup
python3 -m venv .venv
# install CPU torch from PyTorch's own index (skip if you already have
# CUDA torch installed system-wide and want GPU acceleration)
.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
.venv/bin/pip install transformers pillow easyocr sentence-transformers

# 2) build
thumbsup --input ./photos --output ./site \
         --theme-path themes/classic/theme \
         --ai-describe --ai-ocr --ai-embed \
         --ai-python "$(pwd)/.venv/bin/python"
```

`--ai-embed` adds a semantic-search layer on top of the BM25 keyword
search: queries like *"shoreline at the ocean"* will match images
whose caption is *"a beach with a boat"* even though no literal token
overlaps. The two ranks are blended via Reciprocal Rank Fusion (k=60),
so exact-match queries still rank exact hits first.

EasyOCR + sentence-transformers both auto-detect CUDA. With a CUDA-
enabled torch they run ~10-30x faster — pip-install the CUDA build of
torch instead of the `whl/cpu` one above (use the matching index URL
from https://pytorch.org/get-started/locally/).

To use Tesseract instead (CPU-only, ~3x lighter Python install,
sometimes weaker on stylised fonts):

```bash
sudo apt-get install -y tesseract-ocr
.venv/bin/pip install pytesseract
thumbsup ... --ai-ocr-engine tesseract
```

Open `./site/search.html` in any browser. First AI run downloads the BLIP
weights (~450 MB) to your HuggingFace cache; subsequent runs hit a SQLite
cache so only new/changed images are described.

### Server-mode search (Whoosh)

When you grow past tens of thousands of images and the in-browser
MiniSearch index gets too big to ship, switch to server mode. You give up
plain static hosting (GitHub Pages / S3) — instead you run a small Python
process that answers `/api/search?q=…`.

```bash
.venv/bin/pip install whoosh

thumbsup --input ./photos --output ./site \
         --theme-path themes/classic/theme \
         --search-mode server \
         --search-python "$(pwd)/.venv/bin/python"

# then run the server (long-running)
.venv/bin/python scripts/search_server.py serve --site ./site --port 8000
```

Visit `http://localhost:8000/search.html`.

### Server-mode tuning for huge initial builds

Default settings are right for almost everyone, including incremental
rebuilds of huge galleries (because most rebuilds change few docs). If
you're indexing 100k+ images for the very first time:

```bash
thumbsup ... --search-mode server \
             --search-build-procs 4 \
             --search-build-multisegment
```

`--search-build-procs N` parallelises tokenisation across N processes;
`--search-build-multisegment` skips Whoosh's segment merge on commit.
Together they're a big win for the first build, but introduce overhead
that isn't worth it for incremental rebuilds.

---

## Features that have no flag

### Move detection

When you move source files (e.g. `cats/kitten.jpg` → `pets/kitten.jpg`),
thumbsup detects the move by matching `(basename, file size)` between the
"deleted" and "added" entries in its index. For each detected move:

- The thumbnail / small / large output files are **renamed in place** on
  disk (one filesystem rename per output, no regeneration).
- The AI cache (BLIP caption + OCR text) follows the move automatically
  because its key is `(basename, size, mtime)` rather than the full path.
- In server-mode search, the Whoosh index has its `path` field rewritten
  for that doc.

Empty source-side directories left behind by the move are pruned. Move
detection is always on; there's no flag.

### Search page (`search.html`)

A `search.html` is always emitted at the output root. It's rendered
through your theme's handlebars pipeline so it inherits the theme's
look. If your theme provides a `search.hbs`, it's used; otherwise a
generic fallback in `theme-base/search.hbs` is used (visually picks up
your theme's `theme.css` automatically).

Search-result tiles use the theme's actual `{{> thumbnail}}` partial
markup, so they look identical to gallery thumbnails. Click a tile
to open the image in the same lightGallery viewer the album pages
use. (For themes without lightGallery, clicks fall back to opening
the large image directly.)

The five searchable fields, each with its own toggleable scope in the
UI:

| Field | Source |
|---|---|
| Description | BLIP caption (only if `--ai-describe`) |
| OCR | Tesseract output (only if `--ai-ocr`) |
| Manual caption | from EXIF / IPTC / XMP / picasa.ini |
| Filename | basename |
| Path | source path relative to the input root |

Toggles whose underlying field is empty across every image are hidden
automatically.

#### Writing a custom `search.hbs` for your theme

Drop a `search.hbs` next to your theme's `album.hbs` and it will be used
instead of the fallback. The render context is:

| Variable | Type | What it is |
|---|---|---|
| `gallery` | object | Same `gallery` object album pages get (title, footer, all opts) |
| `gallery.home` | Album | The root album — useful for a "back to home" link |
| `home` | Album | Alias of `gallery.home` |
| `album` | object | A virtual album with `path: 'search.html'` so the `{{relative}}` helper works |
| `settings` | object | Whatever is in `--theme-settings` |
| `themeHasLightgallery` | boolean | `true` if `<theme>/public/lightgallery/js/lightgallery-all.min.js` exists |
| `searchTile` | fake File | Pass to `{{> thumbnail}}` to render the template tile (see below) |

The page must contain three things for `search.js` to do its job:

1. **An input** with `id="ts-search-input"`.
2. **An empty `<ul id="media">`** — search.js appends result tiles into it.
3. **A `<template id="ts-search-tile">`** containing exactly one tile
   rendered through your theme's `{{> thumbnail}}` partial, fed the
   `searchTile` placeholder file:

   ```hbs
   <template id="ts-search-tile">
     {{#with searchTile}}
       {{> thumbnail}}
     {{/with}}
   </template>
   ```

   The placeholder values (`__TS_LARGE__`, `__TS_THUMB__`, `__TS_FILENAME__`)
   land in your theme's thumbnail markup wherever `{{urls.large}}`,
   `{{urls.thumbnail}}`, and `{{filename}}` would normally go. `search.js`
   clones this `<template>` per hit and substitutes those sentinels with
   real values, so result tiles end up byte-for-byte identical to gallery
   thumbnails.

Optional, but typical:

- **Scope checkboxes** — give them `class="ts-search-scopes"` on a
  parent and a `data-scope="<field>"` attribute matching one of
  `aiCaption`, `aiOcr`, `caption`, `filename`, `path`. `search.js`
  auto-hides any scope whose field is empty across every image.
- **A counter** with `id="ts-search-count"` for "N matches".
- **`<script>` tags** for jQuery + lightGallery + videojs (gated on
  `{{#if themeHasLightgallery}}`) plus a global
  `window.__TS_LG_OPTIONS__ = {…}` that `search.js` will pass through
  to `$('#media').lightGallery(…)` after each query. If you use a
  different lightbox library, skip this and bind your own click handler
  in your own `<script>` after `search.js` loads — it dispatches a
  `ts:search-results-rendered` event on `#media` after each render.
- **Loading the search assets** at the end of `<body>`:

  ```hbs
  <link rel="stylesheet" href="{{relative 'public/search.css'}}">
  <script src="{{relative 'public/minisearch.min.js'}}"></script>
  <script src="{{relative 'public/search-index.js'}}"></script>
  <script src="{{relative 'public/search.js'}}"></script>
  ```

The shortest possible working `search.hbs` looks like this — everything
beyond the three required elements is optional polish:

```hbs
<!DOCTYPE html>
<html>
<head>
  <title>{{gallery.title}} — Search</title>
  <link rel="stylesheet" href="{{relative 'public/theme.css'}}">
  <link rel="stylesheet" href="{{relative 'public/search.css'}}">
</head>
<body>
  <a href="{{relative gallery.home.url}}">{{gallery.title}}</a> / Search

  <input id="ts-search-input" type="search" autofocus>
  <ul id="media"></ul>

  <template id="ts-search-tile">
    {{#with searchTile}}{{> thumbnail}}{{/with}}
  </template>

  <script src="{{relative 'public/minisearch.min.js'}}"></script>
  <script src="{{relative 'public/search-index.js'}}"></script>
  <script src="{{relative 'public/search.js'}}"></script>
</body>
</html>
```

For a production reference see `src/website/theme-base/search.hbs` (the
fallback) — it's annotated and uses the full set of conventions above.

### Hybrid semantic search (when `--ai-embed` is on)

Each image's `aiCaption + aiOcr` is encoded to a 384-dim sentence-
transformer vector at build time. The search page (both client and
server modes) then runs two rankers in parallel for every query:

1. **BM25** over filename / path / caption / aiCaption / aiOcr (exact
   tokens, prefix, fuzzy — the existing MiniSearch / Whoosh path).
2. **Semantic**: the user's query is embedded with the same model, then
   cosine-similarity ranked against every image's stored vector. In
   client mode this happens in the browser via transformers.js loading
   `Xenova/all-MiniLM-L6-v2`. In server mode it happens in Python with
   `sentence-transformers`.

The two ranks are blended via **Reciprocal Rank Fusion** (k=60). RRF
plays nicely with rankers that have very different score distributions
(BM25 returns scores in the single digits, cosine sim returns 0–1) by
working on rank position, not raw score. The practical effect:

- Exact-match queries (`einstein`) still rank exact filename/caption
  hits first because they win in BM25.
- Synonym/concept queries (`shoreline`, `happy people`, `vintage
  vehicle`) surface images whose captions don't contain the literal
  word at all, but whose meaning matches.

In the result tile, semantic-only hits get a `semantic` badge in the
lightbox caption so you can tell the difference at a glance.

**Browser cost**: ~430 KB transformers.js bundle (loaded once, cached) +
~25 MB ONNX model from the HuggingFace CDN on first semantic query
(also browser-cached). Embeddings ship inline in `search-index.js`
base64-encoded — for 5,000 images that's ~7.5 MB extra.

### Filename in the classic-theme lightbox caption

When viewing an image in the classic theme's lightbox, the bottom
caption strip now shows the filename, plus the manual caption if one
exists. This is in `themes/classic/theme/partials/thumbnail.hbs` —
a partial override that uses lightGallery's `data-sub-html`.

---

## Docker (recommended for long-term use)

The dependency stack here is brittle — Node 24, Python 3.12, torch on
CUDA 12.6, easyocr's torch ABI, sentence-transformers, etc. — and pieces
of it will rot over the years even if the source code stays valid. The
included `Dockerfile` pins everything (system bins, npm modules, every
Python wheel, all model weights baked in) so the same gallery rebuild
keeps working long after upstream packages change or disappear.

The image targets NVIDIA GPUs (CUDA 12.6 runtime). It works on any host
with `nvidia-container-toolkit` installed — Linux native, WSL2 with the
NVIDIA driver, Windows with Docker Desktop + GPU support. macOS is out
unless you only need the CPU path (which would need a separate CPU-only
Dockerfile — not currently shipped).

### Build the image

```bash
docker build -t thumbsup-fork .
```

First build is slow — pulls the CUDA base image (~3 GB), installs torch
+cu126 (~2 GB), and downloads BLIP / EasyOCR / MiniLM model weights
into the image so it works offline forever after. Final image is around
6–8 GB.

### Build a gallery

```bash
docker run --rm --gpus all \
  -v /path/to/photos:/in:ro \
  -v /path/to/site:/out \
  thumbsup-fork \
    --input /in --output /out \
    --theme-path /app/themes/classic/theme \
    --ai-describe --ai-ocr --ai-embed
```

The `--gpus all` flag is what hands the host's GPU(s) into the
container. Without it the image still runs but BLIP/EasyOCR/MiniLM will
fall back to CPU (~30× slower).

`--ai-python` and `--search-python` aren't needed inside the container —
the venv's `python` is first on `PATH`, so the defaults resolve to it.

### Serve a server-mode gallery

```bash
docker run --rm --gpus all -p 8000:8000 \
  -v /path/to/site:/out \
  thumbsup-fork serve --site /out --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` (instead of the default `127.0.0.1`) is needed so the
HTTP server binds to the container's external interface and Docker's
port mapping reaches it.

### Notes

- **Models are baked in.** No HuggingFace round-trip on first use of any
  AI feature inside the container. If you change `--ai-blip-model` or
  `--ai-embed-model` to something not pre-baked, that model will be
  fetched at runtime and only persist for the life of the container.
- **The thumbsup SQLite cache** lives at `/out/thumbsup.db`, so it
  persists across container runs as long as you mount the same `/out`.
- **A non-root user is not configured.** Files written to `/out` are
  owned by root inside the container. If your host user needs to read
  them later, add `--user $(id -u):$(id -g)` to the `docker run` line.
- **Image size.** ~6–8 GB. Most of it is CUDA + torch + cuDNN. The
  models add ~250 MB combined.
- **Shell access for debugging:** `docker run --rm -it --gpus all
  thumbsup-fork shell` drops you into bash inside the container.

## Setup reference

| Need | Install |
|---|---|
| AI captions (`--ai-describe`) | `pip install torch torchvision transformers pillow` |
| OCR (`--ai-ocr`, default `easyocr`) | `pip install easyocr` |
| OCR (`--ai-ocr-engine tesseract`) | `apt install tesseract-ocr` + `pip install pytesseract` |
| Semantic search (`--ai-embed`) | `pip install sentence-transformers` |
| Server-mode search (`--search-mode server`) | `pip install whoosh` |

A single venv covers everything, e.g.:

```bash
python3 -m venv .venv
# Install torch + torchvision from PyTorch's index so easyocr's torchvision
# matches torch's ABI. This is CPU; for GPU use the CUDA index URL instead
# (e.g. cu126 for an NVIDIA card on WSL2 / Linux).
.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
.venv/bin/pip install transformers pillow easyocr sentence-transformers whoosh
```

Pass `--ai-python "$(pwd)/.venv/bin/python"` and
`--search-python "$(pwd)/.venv/bin/python"` so thumbsup uses the venv.

> **Gotcha:** `pip install easyocr` on its own pulls a torchvision build
> from PyPI that may not match your torch ABI, producing
> `register_fake` / `_dispatch_has_kernel_for_dispatch_key` errors at
> import time. Always install torch and torchvision together from the
> same index (the PyTorch CPU index, or the matching CUDA one).

---

## Behavior notes

### What happens when I add `--ai-describe`/`--ai-ocr` to an existing gallery?

Every image currently in the gallery — not just newly added or modified
ones — is checked against the AI cache (`ai_descriptions` table in
`thumbsup.db`) and queued for the Python worker if absent. So flipping
on AI for the first time describes your **whole** gallery, which is
typically what you want.

A few practical things to know:

- **First AI run on a big gallery is slow.** Roughly 1–3 s per image
  for BLIP on CPU, plus OCR. A 5,000-image gallery is a few hours.
  Subsequent rebuilds are fast because cache hits skip Python entirely.
- **Interruption-safe.** Results commit per image, so Ctrl+C halfway
  through 5,000 and then re-run — only the unfinished images get queued
  the next time.
- **Survives moves.** The cache key is `(basename, size, mtime)` rather
  than the full source path, so moving an image to a different folder
  doesn't invalidate its cached caption/OCR.
- **Upgrade from upstream thumbsup is automatic.** The first build with
  this fork runs an `ALTER TABLE files ADD COLUMN size INTEGER`
  migration on your existing `thumbsup.db` and creates the AI table
  fresh. No manual rebuild needed.
- **Search index keeps up.** Switching on `--ai-describe` changes every
  search doc's fingerprint (since `aiCaption` is part of it), so the
  next server-mode Whoosh build updates every doc to include the new
  captions. The MiniSearch client-mode index is rebuilt from scratch on
  every thumbsup run anyway, so it picks them up automatically.

### What happens when I delete or move source files?

Deletes propagate naturally: the source file disappears → the disk-vs-DB
delta marks it `deleted` → its row is removed from `thumbsup.db`, its
output thumbnails get cleaned up (with `--cleanup`), and on the next
search-index build the corresponding Whoosh doc is deleted via
`delete_by_term`.

Moves of source files (a rename, or shifting folders around) are
detected automatically — see [Move detection](#move-detection) above.
Output thumbnails are renamed in place; AI cache and search index
follow.

### How does the embedding cache invalidate?

Embeddings are cached in a separate `ai_embeddings` table (one row per
`(image-hash, model-id)`) so swapping `--ai-embed-model` doesn't
invalidate captions, and turning embeddings off then back on doesn't
re-process them. The image hash is `(basename, size, mtime)` — same as
the description cache — so moves and renames are free.

If you change captions (e.g. because you added `--ai-describe` after a
build that only had `--ai-ocr`), embeddings for those images get
regenerated on the next run because the input text to the embedder
changed. The fingerprint Whoosh uses to detect changed docs in server
mode includes the captions, so the search index updates too.

### What if the AI run crashes mid-image?

The Python worker writes one NDJSON result line per image as it
finishes. The Node side commits each result to SQLite immediately, so
finished images are persisted even if the next image (or the worker
itself) crashes. Rerun thumbsup and it picks up where it left off —
no flag needed, the cache hit/miss logic handles it.

---

## Architecture map (for the curious)

| Concern | Code |
|---|---|
| AI worker (BLIP + OCR + sentence-transformer) | `scripts/ai_describe.py` (long-running) |
| AI driver | `src/components/ai/ai.js` (caches per `(basename, size, mtime)` + per-model embeddings) |
| AI pipeline step | `src/steps/step-ai.js` |
| Browser semantic-search runtime | `@huggingface/transformers` (UMD bundle copied into `public/` when embeddings exist) |
| Server-mode embeddings | `<output>/search-embeddings.npz` (numpy .npz with `keys` + `vectors`) |
| Hybrid ranking | Reciprocal Rank Fusion (k=60), client-side and server-side |
| Move detection | `src/components/index/delta.js` (matches by `(basename, size)`) |
| Move application | `src/components/index/index.js` (DB) + `src/steps/step-moves.js` (output files) |
| Search index build | `src/website/search-index.js` (branches client/server) |
| Whoosh build + server | `scripts/search_server.py` (subcommands `build` + `serve`) |
| Whoosh sidecar cache | `<output>/search-index.whoosh/.fingerprints.json` |
| Search page client | `src/website/search-assets/search.js` |
| Search template (fallback) | `src/website/theme-base/search.hbs` |
| Classic-theme overrides | `themes/classic/theme/` (forked: thumbnail.hbs adds filename to lightbox caption) |
