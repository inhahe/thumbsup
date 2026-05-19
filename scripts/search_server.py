#!/usr/bin/env python3
"""
Server-side search for thumbsup, using Whoosh.

Two subcommands:

    search_server.py build --items items.json --out <dir>
        Called by thumbsup at build time. Reads a JSON array of item dicts
        and writes a Whoosh index to <dir>/search-index.whoosh/.

    search_server.py serve --site <output-dir> [--host 0.0.0.0] [--port 8000]
        Starts a stdlib HTTP server that serves the static gallery from
        <output-dir> and answers /api/search?q=...&scopes=... with JSON.

Install the one runtime dependency with:
    pip install whoosh
"""

import argparse
import json
import os
import sys
from pathlib import Path


# ----- schema ---------------------------------------------------------------

SEARCHABLE_FIELDS = ("filename", "path", "caption", "aiCaption", "aiOcr")
STORED_FIELDS = ("id", "album", "filename", "path", "thumb", "large",
                 "caption", "aiCaption", "aiOcr")


def build_schema():
    from whoosh.fields import Schema, TEXT, STORED, ID
    from whoosh.analysis import RegexTokenizer, LowercaseFilter

    # Tokenise on any run of non-alphanumeric characters so path separators
    # ("/"), underscores and punctuation all split tokens. Same behaviour as
    # the MiniSearch client-mode tokeniser, so results are comparable.
    analyzer = RegexTokenizer(r"[^\W_]+(?:'[^\W_]+)*") | LowercaseFilter()

    return Schema(
        # The source path is the stable unique key — file ids reset every
        # thumbsup run, so they can't be used to identify a doc across runs.
        path_key=ID(stored=True, unique=True),
        # Searchable copy of path (an ID field isn't tokenised).
        path=TEXT(analyzer=analyzer, stored=True),
        filename=TEXT(analyzer=analyzer, stored=True),
        caption=TEXT(analyzer=analyzer, stored=True),
        aiCaption=TEXT(analyzer=analyzer, stored=True),
        aiOcr=TEXT(analyzer=analyzer, stored=True),
        # Stored-only metadata (not searchable, just returned to the client)
        id=STORED,
        album=STORED,
        thumb=STORED,
        large=STORED,
        # Hash of every field above; used to skip unchanged docs on rebuild
        fingerprint=STORED,
    )


# ----- build ---------------------------------------------------------------

def cmd_build(args):
    """Incrementally bring the Whoosh index in sync with items.json.

    Diff is computed by source path (the stable unique key). For each item:
      - new path     -> add_document
      - same path, new fingerprint -> update_document (Whoosh: delete + add)
      - same path, same fingerprint -> skip
    Paths in the index but not in items.json are deleted.
    """
    from whoosh.index import create_in, open_dir, exists_in

    items_path = Path(args.items)
    out_dir = Path(args.out)
    index_dir = out_dir / "search-index.whoosh"

    items = json.loads(items_path.read_text())

    # Open existing index (if present and valid), else create fresh.
    if index_dir.exists() and exists_in(str(index_dir)):
        ix = open_dir(str(index_dir))
        # If the schema on disk doesn't match (e.g. older build), wipe.
        if set(ix.schema.names()) != set(build_schema().names()):
            import shutil
            shutil.rmtree(index_dir)
            index_dir.mkdir(parents=True)
            ix = create_in(str(index_dir), build_schema())
    else:
        if not index_dir.exists():
            index_dir.mkdir(parents=True)
        ix = create_in(str(index_dir), build_schema())

    # Snapshot what's already in the index: { path_key: fingerprint }.
    # Prefer the sidecar cache (written after the previous commit) since it's
    # O(changed-docs-last-time) instead of O(total-docs-in-index). Fall back
    # to scanning the index if the cache is missing or unreadable, which
    # happens on first run after upgrade or if someone deletes the file.
    existing = _load_fingerprints_cache(index_dir)
    if existing is None:
        existing = {}
        with ix.searcher() as searcher:
            for stored in searcher.all_stored_fields():
                existing[stored.get("path_key", "")] = stored.get("fingerprint", "")

    added = 0
    updated = 0
    skipped = 0
    deleted = 0

    writer = ix.writer(
        procs=max(1, args.build_procs),
        multisegment=args.build_multisegment
    )
    new_fingerprints = dict(existing)
    current_keys = set()
    for item in items:
        key = item.get("path", "") or ""
        if not key:
            continue
        current_keys.add(key)
        fp = item.get("fingerprint", "") or ""
        prev_fp = existing.get(key)
        if prev_fp == fp:
            skipped += 1
            continue
        doc = dict(
            path_key=key,
            path=key,
            filename=item.get("filename", "") or "",
            caption=item.get("caption", "") or "",
            aiCaption=item.get("aiCaption", "") or "",
            aiOcr=item.get("aiOcr", "") or "",
            id=str(item.get("id", "")),
            album=item.get("album", "") or "",
            thumb=item.get("thumb", "") or "",
            large=item.get("large", "") or "",
            fingerprint=fp,
        )
        if prev_fp is None:
            writer.add_document(**doc)
            added += 1
        else:
            writer.update_document(**doc)
            updated += 1
        new_fingerprints[key] = fp

    for stale_key in existing.keys() - current_keys:
        writer.delete_by_term("path_key", stale_key)
        new_fingerprints.pop(stale_key, None)
        deleted += 1

    writer.commit()
    _save_fingerprints_cache(index_dir, new_fingerprints)

    # Persist semantic embeddings (if any) as a single .npz beside the
    # Whoosh index. We save (path_key, vector) pairs so the serve command
    # can map ranked indices back to docs without consulting Whoosh first.
    embed_count = _save_embeddings(out_dir, items)

    # Write a manifest so the client and the serve command agree on metadata.
    manifest = {
        "count": len(items),
        "fields": list(SEARCHABLE_FIELDS),
        "embedCount": embed_count,
    }
    (out_dir / "search-manifest.json").write_text(json.dumps(manifest))

    msg = f"[search_server] index sync: +{added} added  ~{updated} updated  -{deleted} removed  ={skipped} unchanged  (total {len(items)})"
    if embed_count > 0:
        msg += f"  [+{embed_count} embeddings]"
    if args.build_procs > 1 or args.build_multisegment:
        msg += f"  [procs={args.build_procs} multisegment={args.build_multisegment}]"
    print(msg)


def _save_embeddings(out_dir, items):
    """Pack all per-item embeddings into a single .npz alongside the index.
    Stored as two arrays: 'keys' (path strings) and 'vectors' (float32 NxD).
    Skips the file entirely if no item has an embedding."""
    pairs = [(it.get("path", ""), it.get("embedding"))
             for it in items if it.get("embedding")]
    embed_path = out_dir / "search-embeddings.npz"
    if not pairs:
        # If embeddings are turned off, drop any stale embeddings file so
        # the serve command doesn't try to use it.
        if embed_path.exists():
            embed_path.unlink()
        return 0
    try:
        import numpy as np
    except ImportError:
        # numpy comes with sentence-transformers; if the build was done
        # without it the embeddings are simply unsaved.
        return 0
    keys = np.array([k for k, _ in pairs])
    vecs = np.asarray([v for _, v in pairs], dtype=np.float32)
    np.savez(embed_path, keys=keys, vectors=vecs)
    return len(pairs)


# Sidecar fingerprint cache helpers — turns the per-build setup cost from
# O(docs-in-index) into O(docs-changed-last-time), which matters once a
# gallery grows past tens of thousands of images.

def _fingerprints_cache_path(index_dir):
    return index_dir / ".fingerprints.json"

def _load_fingerprints_cache(index_dir):
    cache = _fingerprints_cache_path(index_dir)
    if not cache.exists():
        return None
    try:
        data = json.loads(cache.read_text())
        return data if isinstance(data, dict) else None
    except Exception:
        return None

def _save_fingerprints_cache(index_dir, fingerprints):
    cache = _fingerprints_cache_path(index_dir)
    tmp = cache.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(fingerprints))
    tmp.replace(cache)  # atomic on POSIX


def _torch_cuda_available():
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


def _rrf(rankings, k=60):
    """Reciprocal Rank Fusion. Each ranking is an ordered list of identifiers
    (best first). Returns [(id, fused_score), ...] in fused-score order."""
    fused = {}
    for ranking in rankings:
        for rank, ident in enumerate(ranking):
            fused[ident] = fused.get(ident, 0.0) + 1.0 / (k + rank + 1)
    return sorted(fused.items(), key=lambda kv: kv[1], reverse=True)


# ----- serve ---------------------------------------------------------------

def cmd_serve(args):
    from http.server import HTTPServer, SimpleHTTPRequestHandler
    from urllib.parse import urlparse, parse_qs
    from whoosh.index import open_dir
    from whoosh.qparser import MultifieldParser, OrGroup

    site = Path(args.site).resolve()
    index_dir = site / "search-index.whoosh"
    if not index_dir.exists():
        print(f"error: no Whoosh index at {index_dir}", file=sys.stderr)
        print("Build the gallery with --search-mode server first.", file=sys.stderr)
        sys.exit(1)

    ix = open_dir(str(index_dir))

    # Optional semantic layer: if .npz exists alongside the index, load
    # vectors + the model and blend semantic ranks with BM25 via RRF.
    embed_path = site / "search-embeddings.npz"
    embed_keys = None
    embed_vecs = None
    embed_model = None
    if embed_path.exists():
        try:
            import numpy as np
            from sentence_transformers import SentenceTransformer
            data = np.load(embed_path, allow_pickle=False)
            embed_keys = data["keys"]
            embed_vecs = data["vectors"]  # (N, D) float32, normalized
            model_id = args.embed_model
            embed_model = SentenceTransformer(model_id, device=("cuda" if _torch_cuda_available() else "cpu"))
            print(f"[search_server] semantic search ready: {len(embed_keys)} vectors, model {model_id} on {embed_model.device}")
        except Exception as e:
            print(f"[search_server] WARNING: semantic search unavailable ({e}); falling back to BM25 only", file=sys.stderr)
            embed_keys = embed_vecs = embed_model = None

    def whoosh_search(query_str, scopes, limit):
        scopes = [s for s in scopes if s in SEARCHABLE_FIELDS] or list(SEARCHABLE_FIELDS)
        parser = MultifieldParser(scopes, schema=ix.schema, group=OrGroup.factory(0.9))
        try:
            q = parser.parse(query_str)
        except Exception:
            return []
        with ix.searcher() as searcher:
            results = searcher.search(q, limit=limit)
            hits = []
            for r in results:
                hit = {k: r.get(k, "") for k in STORED_FIELDS}
                hit["score"] = r.score
                hits.append(hit)
            return hits

    def semantic_search(query_str, limit):
        if embed_model is None or embed_keys is None:
            return []
        import numpy as np
        qv = embed_model.encode([query_str], normalize_embeddings=True)[0].astype(np.float32)
        sims = embed_vecs @ qv
        # Top-k indices by similarity, descending
        top_idx = np.argpartition(-sims, min(limit, len(sims) - 1))[:limit]
        top_idx = top_idx[np.argsort(-sims[top_idx])]
        return [(str(embed_keys[i]), float(sims[i])) for i in top_idx]

    def do_search(query_str, scopes, limit):
        if not query_str:
            return {"hits": [], "total": 0}
        # Pull more from each ranker than the user asked for so RRF has
        # enough overlap to fuse meaningfully.
        TOP = max(limit, 200)
        bm25_hits = whoosh_search(query_str, scopes, TOP)

        # Skip semantic when the user explicitly turned off both AI scopes
        # — that's the "give me exact matches only" preference.
        semantic_useful = (
            embed_model is not None and
            ("aiCaption" in scopes or "aiOcr" in scopes or not scopes)
        )
        sem_hits = semantic_search(query_str, TOP) if semantic_useful else []

        if not sem_hits:
            # No semantic layer (either disabled or load failed). Plain BM25.
            return {"hits": bm25_hits[:limit], "total": len(bm25_hits)}

        fused = _rrf([
            [h["path"] for h in bm25_hits],
            [k for k, _ in sem_hits],
        ])
        # Build a {path -> stored fields} for quick lookup. Fallback to
        # Whoosh searcher if semantic returned a path that BM25 didn't.
        by_path = {h["path"]: h for h in bm25_hits}
        sem_by_path = dict(sem_hits)
        bm25_paths = set(by_path.keys())
        with ix.searcher() as searcher:
            out = []
            for path_key, fused_score in fused[:limit]:
                hit = by_path.get(path_key)
                if hit is None:
                    # Semantic-only result — fetch it from Whoosh
                    doc = searcher.document(path_key=path_key)
                    if not doc:
                        continue
                    hit = {k: doc.get(k, "") for k in STORED_FIELDS}
                hit = dict(hit)
                hit["score"] = fused_score
                hit["semScore"] = sem_by_path.get(path_key, 0.0)
                hit["semanticOnly"] = path_key not in bm25_paths
                out.append(hit)
        return {"hits": out, "total": len(fused)}

    class Handler(SimpleHTTPRequestHandler):
        # Quiet by default — one line per request is fine
        def log_message(self, format, *args):
            sys.stderr.write("[search_server] %s - %s\n" % (self.address_string(), format % args))

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(site), **kw)

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/api/search":
                params = parse_qs(parsed.query)
                query = (params.get("q", [""])[0] or "").strip()
                scopes = (params.get("scopes", [""])[0] or "").split(",")
                try:
                    limit = min(500, int(params.get("limit", ["100"])[0]))
                except ValueError:
                    limit = 100
                scopes = [s for s in scopes if s]
                payload = do_search(query, scopes, limit)
                body = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            # fall through to static file serving
            super().do_GET()

    httpd = HTTPServer((args.host, args.port), Handler)
    print(f"[search_server] serving {site} on http://{args.host}:{args.port}  (index: {index_dir.name})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[search_server] shutting down")


# ----- main ----------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="Build the Whoosh index from items.json")
    b.add_argument("--items", required=True, help="Path to items.json")
    b.add_argument("--out", required=True, help="Gallery output directory")
    b.add_argument("--build-procs", type=int, default=1,
                   help="Number of indexing processes Whoosh uses (default: 1). "
                        "Useful when bulk-adding tens of thousands of new docs; "
                        "introduces pickling overhead per doc, not worth it for "
                        "small incremental builds.")
    b.add_argument("--build-multisegment", action="store_true",
                   help="Skip the segment merge on commit (faster build, slightly "
                        "slower searches until you run an explicit optimize). "
                        "Worth enabling for the very first build of a huge gallery.")
    b.set_defaults(func=cmd_build)

    s = sub.add_parser("serve", help="Serve the gallery and answer /api/search")
    s.add_argument("--site", required=True, help="Gallery output directory")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--embed-model",
                   default="sentence-transformers/all-MiniLM-L6-v2",
                   help="Sentence-transformer model for semantic query embedding "
                        "(must match the model used at build time)")
    s.set_defaults(func=cmd_serve)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
