/*
--------------------------------------------------------------------------------
AI descriptor: spawns a long-running Python worker that streams
{caption, ocr, embedding} results for each image, and caches them in
SQLite keyed by file content hash so rebuilds are cheap.

Two cache tables, on purpose:
  ai_descriptions  (hash, caption, ocr)  — one row per image
  ai_embeddings    (hash, model, vector) — one row per (image, model)
                                           so swapping the embed model
                                           doesn't invalidate captions
--------------------------------------------------------------------------------
*/

const EventEmitter = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const Database = require('better-sqlite3')

const HELPER = path.join(__dirname, '..', '..', '..', 'scripts', 'ai_describe.py')
const DEFAULT_EMBED_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'

function hashFile (fullPath) {
  // Key on (basename + size + mtime) so that a file moved between directories
  // keeps its cached caption/OCR. We don't include the directory path to stay
  // consistent with how step-moves.js reuses thumbnail outputs.
  const h = crypto.createHash('sha1')
  const stat = fs.statSync(fullPath)
  h.update(path.basename(fullPath))
  h.update(String(stat.size))
  h.update(String(stat.mtimeMs))
  return h.digest('hex')
}

// Convert a number[] of floats to a Float32Array, then to a Buffer for
// SQLite BLOB storage. Reverses with bufferToFloats below.
function floatsToBuffer (arr) {
  const f32 = new Float32Array(arr)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

function bufferToFloats (buf) {
  // Returns a Float32Array view; copy if you need to mutate.
  const aligned = Buffer.from(buf) // ensures aligned underlying buffer
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
}

class AIDescriber {
  constructor (databaseFile, opts = {}) {
    this.opts = opts
    this.python = opts.aiPython || 'python3'
    this.includeCaption = opts.aiDescribe !== false
    this.includeOcr = opts.aiOcr !== false
    this.includeEmbed = !!opts.aiEmbed
    this.embedModel = opts.aiEmbedModel || DEFAULT_EMBED_MODEL
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true })
    this.db = new Database(databaseFile, {})
    this.db.exec('CREATE TABLE IF NOT EXISTS ai_descriptions (hash TEXT PRIMARY KEY, caption TEXT, ocr TEXT)')
    this.db.exec('CREATE TABLE IF NOT EXISTS ai_embeddings (hash TEXT, model TEXT, vector BLOB, PRIMARY KEY (hash, model))')
    this.selectDesc = this.db.prepare('SELECT caption, ocr FROM ai_descriptions WHERE hash = ?')
    this.insertDesc = this.db.prepare('INSERT OR REPLACE INTO ai_descriptions VALUES (?, ?, ?)')
    this.selectEmbed = this.db.prepare('SELECT vector FROM ai_embeddings WHERE hash = ? AND model = ?')
    this.insertEmbed = this.db.prepare('INSERT OR REPLACE INTO ai_embeddings VALUES (?, ?, ?)')
  }

  lookupDesc (hash) {
    return this.selectDesc.get(hash) || null
  }

  lookupEmbed (hash) {
    const row = this.selectEmbed.get(hash, this.embedModel)
    if (!row) return null
    return bufferToFloats(row.vector)
  }

  /*
    Process all image files, emitting progress as we go.
    Returns an EventEmitter with 'progress' and 'done' events.
    Each file receives .meta.aiCaption, .meta.aiOcr (strings), and
    .meta.aiEmbedding (Float32Array | null).
  */
  run (files, inputRoot) {
    const emitter = new EventEmitter()
    const images = files.filter(f => f.type === 'image')

    // Figure out which files are cache hits vs need work, separately for
    // text-description and embedding so users can enable them at different
    // points in time without redoing work that's already cached.
    const work = []
    for (const f of images) {
      const fullPath = path.join(inputRoot, f.path)
      let hash
      try {
        hash = hashFile(fullPath)
      } catch (err) {
        f.meta.aiCaption = ''
        f.meta.aiOcr = ''
        f.meta.aiEmbedding = null
        continue
      }
      const descCached = this.lookupDesc(hash)
      const embedCached = this.includeEmbed ? this.lookupEmbed(hash) : null
      if (descCached) {
        f.meta.aiCaption = descCached.caption || ''
        f.meta.aiOcr = descCached.ocr || ''
      }
      if (embedCached) {
        f.meta.aiEmbedding = embedCached
      }
      const needsDesc = !descCached && (this.includeCaption || this.includeOcr)
      const needsEmbed = this.includeEmbed && !embedCached
      if (needsDesc || needsEmbed) {
        work.push({ file: f, hash, fullPath, needsEmbed })
      }
    }

    // Default empty for non-images (and any image we couldn't hash above)
    for (const f of files) {
      if (f.meta.aiCaption === undefined) f.meta.aiCaption = ''
      if (f.meta.aiOcr === undefined) f.meta.aiOcr = ''
      if (f.meta.aiEmbedding === undefined) f.meta.aiEmbedding = null
    }

    const total = work.length
    let processed = 0
    emitter.emit('progress', { processed, total })

    if (total === 0) {
      process.nextTick(() => emitter.emit('done', { processed, total }))
      return emitter
    }

    const args = [HELPER]
    if (!this.includeCaption) args.push('--no-caption')
    if (!this.includeOcr) args.push('--no-ocr')
    if (this.includeEmbed) {
      args.push('--embed')
      args.push('--embed-model', this.embedModel)
    }
    if (this.opts.aiBlipModel) args.push('--blip-model', this.opts.aiBlipModel)
    if (this.opts.aiOcrEngine) args.push('--ocr-engine', this.opts.aiOcrEngine)

    // Pipe (not inherit) the child's stderr so messages like "BlipFor...
    // LOAD REPORT" don't stomp all over Listr's cursor-redraw output.
    // We buffer stderr and only dump it to the real terminal if the child
    // exits non-zero, so the user can still diagnose a real crash.
    const child = spawn(this.python, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const byId = new Map()
    work.forEach((w, i) => byId.set(String(i), w))

    let stdoutBuf = ''
    let ready = false
    let doneEmitted = false
    const pendingWrite = []
    const stderrChunks = []
    child.stderr.on('data', chunk => stderrChunks.push(chunk))

    // Emit 'done' as soon as we've received every result. Python may still
    // be tearing down torch/CUDA at exit — that's fine to let happen in the
    // background while the rest of the pipeline (cleanup, rendering) runs.
    // Without this, a gallery with only a handful of cache-miss images
    // would sit at "Describing 1/1 (100%)" for 30-60s waiting for Python.
    const maybeEmitDone = () => {
      if (doneEmitted) return
      if (processed !== total) return
      doneEmitted = true
      emitter.emit('done', { processed, total })
      // Give Python a moment to exit cleanly, then hurry it along. SIGTERM
      // lets its atexit handlers run; if it's really stuck, next run will
      // spawn a fresh one anyway so no lasting harm.
      setTimeout(() => {
        try { if (!child.killed) child.kill('SIGTERM') } catch { /* ignore */ }
      }, 5000)
    }

    const flush = () => {
      if (!ready) return
      while (pendingWrite.length) {
        child.stdin.write(pendingWrite.shift())
      }
    }

    child.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString('utf8')
      let nl
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.ready) {
          ready = true
          emitter.emit('ready', {
            device: msg.device || 'unknown',
            captioner: !!msg.captioner,
            captionerDevice: msg.captionerDevice || 'unknown',
            ocr: !!msg.ocr,
            ocrDevice: msg.ocrDevice || 'unknown',
            ocrEngine: msg.ocrEngine || 'unknown',
            embed: !!msg.embed,
            embedDevice: msg.embedDevice || 'unknown',
            embedModel: msg.embedModel || 'none',
            embedDim: msg.embedDim || 0
          })
          // queue all jobs
          for (const [id, w] of byId.entries()) {
            pendingWrite.push(JSON.stringify({ id, path: w.fullPath }) + '\n')
          }
          flush()
          child.stdin.end()
          continue
        }
        const w = byId.get(msg.id)
        if (!w) continue
        const caption = msg.caption || ''
        const ocr = msg.ocr || ''
        this.insertDesc.run(w.hash, caption, ocr)
        w.file.meta.aiCaption = caption
        w.file.meta.aiOcr = ocr
        if (Array.isArray(msg.embedding) && msg.embedding.length > 0) {
          const buf = floatsToBuffer(msg.embedding)
          this.insertEmbed.run(w.hash, this.embedModel, buf)
          w.file.meta.aiEmbedding = bufferToFloats(buf)
        }
        processed++
        emitter.emit('progress', { processed, total, path: w.file.path })
        maybeEmitDone()
      }
    })

    child.on('error', err => emitter.emit('error', err))
    child.on('close', code => {
      // SIGTERM (from maybeEmitDone's timeout) surfaces as code=null /
      // signal='SIGTERM'. That's not a real error — we already have every
      // result we needed.
      if (doneEmitted) return
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
        const msg = stderr
          ? `ai_describe.py exited with code ${code}:\n${stderr}`
          : `ai_describe.py exited with code ${code}`
        emitter.emit('error', new Error(msg))
      } else {
        // any un-returned jobs get empty strings
        for (const w of byId.values()) {
          if (w.file.meta.aiCaption === undefined) {
            w.file.meta.aiCaption = ''
            w.file.meta.aiOcr = ''
          }
        }
        emitter.emit('done', { processed, total })
      }
    })

    return emitter
  }
}

module.exports = AIDescriber
module.exports.DEFAULT_EMBED_MODEL = DEFAULT_EMBED_MODEL
