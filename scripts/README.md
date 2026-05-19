# scripts/

Helper Python scripts used by the [fork additions](../FORK.md):

- **`ai_describe.py`** — long-running worker that BLIP-captions and OCRs
  images. Spawned by thumbsup at build time when `--ai-describe` or
  `--ai-ocr` is set. See [FORK.md](../FORK.md#with-ai-captions--ocr--search).

- **`search_server.py`** — two subcommands:
  - `build` is invoked by thumbsup at build time when `--search-mode server`
    is set, to populate the Whoosh index.
  - `serve` is run by you to host the gallery + answer `/api/search?q=…`.
    See [FORK.md](../FORK.md#server-mode-search-whoosh).

Setup commands and CLI flag reference live in [FORK.md](../FORK.md) at the
repo root.
