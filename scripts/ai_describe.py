#!/usr/bin/env python3
"""
Batch AI descriptor for thumbsup.

Reads NDJSON jobs on stdin, one per line: {"id": "...", "path": "/abs/path.jpg"}
Writes NDJSON results on stdout:
    {"id": "...", "caption": "...", "ocr": "...", "embedding": [floats] | null}

Models are loaded lazily and kept warm across jobs, so the Node side should
spawn one long-running process and stream work to it rather than fork per image.

Flags:
  --no-caption        skip BLIP captioning
  --no-ocr            skip OCR
  --embed             also produce sentence-transformer embeddings of
                      (caption + " " + ocr) for hybrid semantic search
  --ocr-engine        which OCR backend to use: 'easyocr' (default, GPU-capable)
                      or 'tesseract' (CPU-only, lighter install)
  --blip-model        override the HuggingFace model id
                      (default: Salesforce/blip-image-captioning-base)
  --embed-model       sentence-transformer model id
                      (default: sentence-transformers/all-MiniLM-L6-v2)
"""

import argparse
import json
import sys
import traceback


def log(msg):
    print(msg, file=sys.stderr, flush=True)


class Captioner:
    def __init__(self, model_id):
        from transformers import BlipProcessor, BlipForConditionalGeneration
        log(f"[ai_describe] loading BLIP: {model_id}")
        self.processor = BlipProcessor.from_pretrained(model_id)
        self.model = BlipForConditionalGeneration.from_pretrained(model_id)
        try:
            import torch
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            self.model.to(self.device)
        except Exception:
            self.device = "cpu"
        log(f"[ai_describe] BLIP ready on {self.device}")

    def caption(self, image):
        inputs = self.processor(image, return_tensors="pt").to(self.device)
        out = self.model.generate(**inputs, max_new_tokens=40)
        return self.processor.decode(out[0], skip_special_tokens=True).strip()


class TesseractOCR:
    """CPU-only OCR via Google's Tesseract. Lightweight install, fast on
    short text, weaker on stylised fonts. Default for users who don't have
    a GPU and want minimal Python deps."""

    def __init__(self):
        import pytesseract
        self.pytesseract = pytesseract
        # Tesseract has no GPU path.
        self.device = "cpu"
        log("[ai_describe] Tesseract ready (CPU)")

    def read(self, image):
        text = self.pytesseract.image_to_string(image)
        return " ".join(text.split()).strip()


class EasyOCREngine:
    """PyTorch-based OCR. Uses CUDA when available (auto-falls-back to CPU
    with a warning), generally better than Tesseract on memes / stylised
    fonts / signs. ~100MB model download on first use."""

    def __init__(self):
        try:
            import easyocr
        except ImportError as e:
            raise SystemExit(
                "[ai_describe] easyocr is not installed. Install it with "
                "`pip install easyocr`, or pass --ocr-engine tesseract."
            ) from e
        try:
            import torch
            use_gpu = torch.cuda.is_available()
        except Exception:
            use_gpu = False
        # Stays quiet when GPU unavailable; EasyOCR otherwise prints a long
        # warning to stderr that we don't want cluttering the build log.
        self.reader = easyocr.Reader(["en"], gpu=use_gpu, verbose=False)
        self.device = "cuda" if use_gpu else "cpu"
        log(f"[ai_describe] EasyOCR ready ({self.device})")

    def read(self, image):
        # easyocr accepts file paths or numpy arrays. PIL Images convert
        # cheaply via numpy.array.
        import numpy as np
        arr = np.array(image)
        result = self.reader.readtext(arr)
        # Each entry is (bbox, text, confidence). We just want the text.
        return " ".join(text for _, text, _ in result).strip()


class Embedder:
    """Sentence-transformer for semantic search. The same model id is used
    in the browser via transformers.js (Xenova's ONNX export) so vectors
    line up with the client-side query embedding."""

    def __init__(self, model_id):
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as e:
            raise SystemExit(
                "[ai_describe] sentence-transformers is not installed. Install it "
                "with `pip install sentence-transformers`, or pass --no-embed "
                "(omit --embed)."
            ) from e
        try:
            import torch
            use_gpu = torch.cuda.is_available()
        except Exception:
            use_gpu = False
        self.model_id = model_id
        self.model = SentenceTransformer(model_id, device="cuda" if use_gpu else "cpu")
        self.device = "cuda" if use_gpu else "cpu"
        self.dim = self.model.get_sentence_embedding_dimension()
        log(f"[ai_describe] Embedder ready ({self.device}, dim={self.dim})")

    def embed(self, text):
        # normalize_embeddings=True so cosine similarity is just a dot product.
        # Returns a python list (json-serialisable).
        vec = self.model.encode([text], normalize_embeddings=True)[0]
        return [float(x) for x in vec]


def make_ocr(engine):
    if engine == "tesseract":
        return TesseractOCR()
    if engine == "easyocr":
        return EasyOCREngine()
    raise SystemExit(f"[ai_describe] unknown OCR engine: {engine}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-caption", action="store_true")
    parser.add_argument("--no-ocr", action="store_true")
    parser.add_argument("--embed", action="store_true",
                        help="Also produce sentence-transformer embeddings")
    parser.add_argument(
        "--ocr-engine",
        default="easyocr",
        choices=["easyocr", "tesseract"],
        help="OCR backend: easyocr (GPU-capable, default) or tesseract (CPU)",
    )
    parser.add_argument(
        "--blip-model", default="Salesforce/blip-image-captioning-base"
    )
    parser.add_argument(
        "--embed-model", default="sentence-transformers/all-MiniLM-L6-v2"
    )
    args = parser.parse_args()

    captioner = None if args.no_caption else Captioner(args.blip_model)
    ocr = None if args.no_ocr else make_ocr(args.ocr_engine)
    embedder = Embedder(args.embed_model) if args.embed else None

    from PIL import Image

    # Report load + device info so the Node side can surface it in the UI.
    # BLIP, EasyOCR, and the embedder all follow torch.cuda.is_available();
    # Tesseract is CPU-only. The "device" field summarises the slowest of
    # the three so the user notices when they're falling back to CPU.
    captioner_device = captioner.device if captioner else None
    ocr_device = ocr.device if ocr else None
    embed_device = embedder.device if embedder else None
    devices_in_play = [d for d in (captioner_device, ocr_device, embed_device) if d]
    if not devices_in_play:
        overall = "n/a"
    elif all(d == "cuda" for d in devices_in_play):
        overall = "cuda"
    else:
        overall = "cpu"
    print(json.dumps({
        "ready": True,
        "device": overall,
        "captionerDevice": captioner_device or "n/a",
        "ocrDevice": ocr_device or "n/a",
        "embedDevice": embed_device or "n/a",
        "ocrEngine": args.ocr_engine if ocr else "none",
        "embedModel": args.embed_model if embedder else "none",
        "embedDim": embedder.dim if embedder else 0,
        "captioner": captioner is not None,
        "ocr": ocr is not None,
        "embed": embedder is not None
    }), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            job_id = job.get("id")
            path = job["path"]
            with Image.open(path) as im:
                im = im.convert("RGB")
                caption = captioner.caption(im) if captioner else ""
                ocr_text = ocr.read(im) if ocr else ""
            embedding = None
            if embedder is not None:
                # Embed the concatenation of caption + OCR (whichever are
                # available). If both are empty the embedding wouldn't add
                # anything searchable, so we skip — the search-index can
                # still BM25-match the manual caption / filename / path.
                text_for_embed = " ".join(filter(None, [caption.strip(), ocr_text.strip()]))
                if text_for_embed:
                    embedding = embedder.embed(text_for_embed)
            result = {"id": job_id, "caption": caption, "ocr": ocr_text, "embedding": embedding}
        except BrokenPipeError:
            # Parent (Node) closed the pipe — it's exited or crashed.
            # Nothing useful we can do; bail silently rather than dump a
            # traceback that confuses the real (upstream) error.
            sys.exit(0)
        except Exception as e:
            result = {
                "id": job.get("id") if isinstance(job, dict) else None,
                "caption": "",
                "ocr": "",
                "error": f"{type(e).__name__}: {e}",
            }
            traceback.print_exc(file=sys.stderr)
        try:
            print(json.dumps(result), flush=True)
        except BrokenPipeError:
            sys.exit(0)


if __name__ == "__main__":
    main()
