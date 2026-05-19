/*
--------------------------------------------------------------------------------
Emits the assets needed by the search page. Two modes:

  client (default) — ships a prebuilt MiniSearch index + raw item data to the
                     browser so search runs entirely in JS (works on any static
                     host).

  server           — writes an items.json file and invokes a Python helper to
                     build a Whoosh index at <output>/search-index.whoosh/. The
                     user then runs `scripts/search_server.py serve` to answer
                     /api/search from that index. Requires a running Python
                     process — incompatible with plain static hosting.
--------------------------------------------------------------------------------
*/

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const MiniSearch = require('minisearch')

const HELPER = path.join(__dirname, '..', '..', 'scripts', 'search_server.py')

function collect (album, out) {
  for (const file of album.files) {
    out.push({
      id: file.id,
      album: album.url,
      filename: file.filename,
      path: file.path,
      thumb: file.urls.thumbnail,
      large: file.urls.large || file.urls.small || file.urls.thumbnail,
      caption: file.meta.caption || '',
      aiCaption: file.meta.aiCaption || '',
      aiOcr: file.meta.aiOcr || '',
      // Float32Array (semantic embedding) or null. Stripped before JSON
      // serialisation; packed separately in client mode, sent as plain
      // arrays to Python in server mode.
      _embedding: file.meta.aiEmbedding || null
    })
  }
  for (const nested of album.albums) {
    collect(nested, out)
  }
}

const SEARCH_FIELDS = ['filename', 'path', 'caption', 'aiCaption', 'aiOcr']
const STORE_FIELDS = ['album', 'filename', 'path', 'thumb', 'large', 'caption', 'aiCaption', 'aiOcr']

exports.write = function (rootAlbum, outputDir, opts) {
  const items = []
  collect(rootAlbum, items)
  const publicDir = path.join(outputDir, 'public')
  fs.mkdirSync(publicDir, { recursive: true })

  // Copy the common client assets (CSS + search glue JS) in both modes.
  const assetsDir = path.join(__dirname, 'search-assets')
  for (const asset of ['search.js', 'search.css']) {
    fs.copyFileSync(path.join(assetsDir, asset), path.join(publicDir, asset))
  }

  const mode = (opts && opts.searchMode) || 'client'
  if (mode === 'server') {
    writeServerMode(items, outputDir, publicDir, opts)
  } else {
    writeClientMode(items, publicDir, opts)
  }
}

function writeClientMode (items, publicDir, opts) {
  // Strip the embedding off the item before MiniSearch + JSON serialisation,
  // and pack it into a contiguous Float32Array for efficient transport.
  const embeddings = []
  let embedDim = 0
  const hasEmbedding = []
  const itemsForJson = items.map(item => {
    const { _embedding, ...rest } = item
    if (_embedding && _embedding.length) {
      if (!embedDim) embedDim = _embedding.length
      embeddings.push(_embedding)
      hasEmbedding.push(true)
    } else {
      hasEmbedding.push(false)
    }
    return rest
  })

  // Build the MiniSearch index at build time so the browser just loads it.
  const ms = new MiniSearch({
    fields: SEARCH_FIELDS,
    storeFields: STORE_FIELDS,
    tokenize: (text) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
    processTerm: (term) => term.toLowerCase()
  })
  ms.addAll(itemsForJson)

  // Pack all embeddings into one contiguous Float32Array, then base64.
  // The browser decodes back to a Float32Array view in O(1).
  let embedB64 = ''
  if (embeddings.length) {
    const flat = new Float32Array(embeddings.length * embedDim)
    let offset = 0
    for (const v of embeddings) {
      flat.set(v, offset)
      offset += embedDim
    }
    embedB64 = Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength).toString('base64')
  }

  const config = {
    mode: 'client',
    count: items.length,
    embedDim,
    embedModel: opts && opts.aiEmbedModel ? opts.aiEmbedModel : null,
    // Browser-side model id (Xenova ONNX export). For most popular
    // sentence-transformers models the convention is Xenova/<basename>.
    embedBrowserModel: embedDim > 0 ? toBrowserModelId(opts && opts.aiEmbedModel) : null
  }

  const payload =
    'window.__THUMBSUP_SEARCH_CONFIG__ = ' + JSON.stringify(config) + ';\n' +
    'window.__THUMBSUP_SEARCH__ = {\n' +
    '  items: ' + JSON.stringify(itemsForJson) + ',\n' +
    '  index: ' + JSON.stringify(ms) + ',\n' +
    '  options: ' + JSON.stringify({ fields: SEARCH_FIELDS, storeFields: STORE_FIELDS }) + ',\n' +
    '  fields: ' + JSON.stringify(SEARCH_FIELDS) + ',\n' +
    '  hasEmbedding: ' + JSON.stringify(hasEmbedding) + ',\n' +
    '  embeddingsB64: ' + JSON.stringify(embedB64) + '\n' +
    '};\n'
  fs.writeFileSync(path.join(publicDir, 'search-index.js'), payload)

  // Copy the MiniSearch UMD build so the browser gets a global MiniSearch.
  const minisearchMain = require.resolve('minisearch')
  const minisearchPkgDir = path.dirname(minisearchMain).replace(/[\\/]dist[\\/].*$/, '')
  const minisearchUmd = path.join(minisearchPkgDir, 'dist', 'umd', 'index.js')
  fs.copyFileSync(minisearchUmd, path.join(publicDir, 'minisearch.min.js'))

  // Copy transformers.js if we have embeddings to query against. The
  // browser dynamically imports it on the first semantic-capable query —
  // no <script type="module"> needed in the theme template.
  if (embedB64) {
    copyTransformersBundle(publicDir)
  }
}

function toBrowserModelId (pyId) {
  if (!pyId) return 'Xenova/all-MiniLM-L6-v2'
  if (pyId.startsWith('Xenova/')) return pyId
  // sentence-transformers/X -> Xenova/X (the Xenova org maintains ONNX
  // exports of the popular sentence-transformers under matching basenames).
  return 'Xenova/' + pyId.split('/').pop()
}

function copyTransformersBundle (publicDir) {
  // The package's exports map hides ./package.json — locate dist/ via
  // the main entry instead, which always resolves.
  const mainEntry = require.resolve('@huggingface/transformers')
  const distDir = path.dirname(mainEntry)
  // Copy the web bundle and the onnxruntime WASM helper module it pulls in.
  fs.copyFileSync(path.join(distDir, 'transformers.web.min.js'),
                  path.join(publicDir, 'transformers.min.js'))
  // The WASM glue script lives next to it and is fetched relative to the
  // bundle URL. Copy it too so requests stay self-contained.
  const wasmGlue = 'ort-wasm-simd-threaded.jsep.mjs'
  if (fs.existsSync(path.join(distDir, wasmGlue))) {
    fs.copyFileSync(path.join(distDir, wasmGlue), path.join(publicDir, wasmGlue))
  }
}

// Fingerprint for incremental indexing: hash of every field that affects
// the search result for an item. If the fingerprint is unchanged, Python
// skips the doc; if it differs, the doc is replaced.
function fingerprint (item) {
  const h = crypto.createHash('sha1')
  h.update(item.path || '')
  h.update('\0')
  h.update(item.filename || '')
  h.update('\0')
  h.update(item.caption || '')
  h.update('\0')
  h.update(item.aiCaption || '')
  h.update('\0')
  h.update(item.aiOcr || '')
  h.update('\0')
  h.update(item.thumb || '')
  h.update('\0')
  h.update(item.large || '')
  h.update('\0')
  h.update(item.album || '')
  return h.digest('hex')
}

function writeServerMode (items, outputDir, publicDir, opts) {
  // The browser doesn't need the item data in server mode — the server owns
  // it and returns hits. We write only a tiny config (count + flag).
  const config =
    'window.__THUMBSUP_SEARCH_CONFIG__ = {\n' +
    '  mode: "server",\n' +
    '  count: ' + items.length + ',\n' +
    '  endpoint: "/api/search",\n' +
    '  fields: ' + JSON.stringify(SEARCH_FIELDS) + '\n' +
    '};\n'
  fs.writeFileSync(path.join(publicDir, 'search-index.js'), config)

  // Stub so the shared <script src="public/minisearch.min.js"> tag in the
  // theme doesn't 404 in server mode. (We could teach the theme to omit the
  // tag instead, but that's more template surgery for two lines of JS.)
  fs.writeFileSync(path.join(publicDir, 'minisearch.min.js'), '/* not used in server mode */\n')

  // Hand the item data to the Python helper which builds the Whoosh index.
  // Each item carries a fingerprint so the helper can skip unchanged docs.
  // The Float32Array embedding is converted to a plain number[] so it
  // round-trips through JSON. Items without an embedding get null.
  const enriched = items.map(i => {
    const embedding = i._embedding ? Array.from(i._embedding) : null
    const { _embedding, ...rest } = i
    return Object.assign({}, rest, { embedding, fingerprint: fingerprint(rest) })
  })
  const itemsJsonPath = path.join(outputDir, 'search-items.json')
  fs.writeFileSync(itemsJsonPath, JSON.stringify(enriched))

  const python = (opts && opts.searchPython) || 'python3'
  const args = [HELPER, 'build', '--items', itemsJsonPath, '--out', outputDir]
  if (opts && opts.searchBuildProcs && opts.searchBuildProcs > 1) {
    args.push('--build-procs', String(opts.searchBuildProcs))
  }
  if (opts && opts.searchBuildMultisegment) {
    args.push('--build-multisegment')
  }
  const result = spawnSync(python, args, {
    stdio: ['ignore', 'inherit', 'inherit']
  })
  if (result.error) {
    throw new Error(`Failed to spawn ${python}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`search_server.py build exited with code ${result.status}`)
  }
}
