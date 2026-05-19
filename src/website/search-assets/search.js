(function () {
  'use strict'

  var config = window.__THUMBSUP_SEARCH_CONFIG__ || { mode: 'client', count: 0 }
  var mode = config.mode
  var input = document.getElementById('ts-search-input')
  var media = document.getElementById('media')
  var template = document.getElementById('ts-search-tile')
  var count = document.getElementById('ts-search-count')
  var scopeBoxes = [].slice.call(document.querySelectorAll('.ts-search-scopes input'))

  var tileHtml = template ? template.innerHTML.trim() : ''

  // Client mode: load the prebuilt MiniSearch index + (optionally)
  // decode the packed embeddings array. Server mode: nothing — we'll
  // fetch /api/search instead.
  var data = window.__THUMBSUP_SEARCH__ || { items: [], index: null, options: {}, fields: [] }
  var ms = null
  if (mode === 'client' && data.index && window.MiniSearch) {
    ms = window.MiniSearch.loadJS(data.index, Object.assign({}, data.options, {
      tokenize: function (text) { return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean) },
      processTerm: function (term) { return term.toLowerCase() }
    }))
  }

  // Decode the packed embeddings (Float32Array) once. Each item's slice
  // is at index `embeddingIndexFor(i) * embedDim` in this flat buffer;
  // -1 means the item has no embedding (e.g. nothing to embed).
  var embeddings = null
  var embedDim = config.embedDim || 0
  var embeddingIndexByItem = []
  if (mode === 'client' && embedDim > 0 && data.embeddingsB64) {
    embeddings = decodeBase64ToFloat32(data.embeddingsB64)
    var idx = 0
    for (var i = 0; i < data.hasEmbedding.length; i++) {
      embeddingIndexByItem.push(data.hasEmbedding[i] ? idx++ : -1)
    }
  }

  // Lazy-loaded transformers.js pipeline for query embedding. Only created
  // on the first semantic-capable query so the ~25MB model doesn't
  // download until the user actually searches.
  var embedderPromise = null
  function getEmbedder () {
    if (embedderPromise) return embedderPromise
    if (!window.__TS_TRANSFORMERS_URL__ || !window.__TS_EMBED_MODEL__) {
      embedderPromise = Promise.resolve(null)
      return embedderPromise
    }
    embedderPromise = (async function () {
      try {
        var mod = await import(window.__TS_TRANSFORMERS_URL__)
        return await mod.pipeline('feature-extraction', window.__TS_EMBED_MODEL__)
      } catch (err) {
        console.warn('[ts-search] transformers.js failed to load; semantic search disabled.', err)
        return null
      }
    })()
    return embedderPromise
  }

  // Hide scope toggles whose underlying field is empty across every item.
  if (mode === 'client') {
    scopeBoxes.forEach(function (b) {
      var scope = b.getAttribute('data-scope')
      var any = data.items.some(function (item) { return (item[scope] || '') !== '' })
      if (!any) {
        b.checked = false
        var lbl = b.closest('label')
        if (lbl) lbl.style.display = 'none'
      }
    })
  }

  function activeScopes () {
    return scopeBoxes
      .filter(function (b) { return b.checked && b.offsetParent !== null })
      .map(function (b) { return b.getAttribute('data-scope') })
  }

  function escapeHtml (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  var SCOPE_LABEL = {
    aiCaption: 'desc',
    aiOcr: 'ocr',
    caption: 'caption',
    filename: 'file',
    path: 'path',
    semantic: 'semantic'
  }
  function pickScope (hit, terms, scopes) {
    var best = null
    var bestCount = -1
    for (var i = 0; i < scopes.length; i++) {
      var s = scopes[i]
      var val = hit[s]
      if (!val) continue
      var lc = String(val).toLowerCase()
      var c = 0
      for (var j = 0; j < terms.length; j++) {
        if (lc.indexOf(terms[j].toLowerCase()) >= 0) c++
      }
      if (c > bestCount) { bestCount = c; best = s }
    }
    return best || scopes[0]
  }

  function destroyLightGallery () {
    if (!window.jQuery) return
    var $m = window.jQuery('#media')
    var d = $m.data('lightGallery')
    if (d && typeof d.destroy === 'function') {
      try { d.destroy(true) } catch (e) { /* ignore */ }
    }
    $m.removeData('lightGallery')
  }
  function initLightGallery () {
    if (!window.jQuery || !window.jQuery.fn.lightGallery) return
    var opts = window.__TS_LG_OPTIONS__ || {}
    window.jQuery('#media').lightGallery(opts)
  }

  function renderTilesFromHits (hits, terms, scopes) {
    media.innerHTML = ''
    if (!hits.length) return
    var html = ''
    for (var i = 0; i < hits.length; i++) {
      var hit = hits[i]
      var scope = hit._semantic ? 'semantic' : pickScope(hit, terms, scopes)
      var subHtmlMeta = hit._semantic ? '~' + hit._semScore.toFixed(2) : (hit.path || '')
      var subHtml =
        "<div class='lg-filename'>" + escapeHtml(hit.filename) + "</div>" +
        "<div class='lg-search-meta'>" +
          "<span class='ts-result-scope'>" + SCOPE_LABEL[scope] + "</span> " +
          escapeHtml(subHtmlMeta) +
        "</div>"
      var tile = tileHtml
        .split('__TS_LARGE__').join(escapeHtml(hit.large))
        .split('__TS_THUMB__').join(escapeHtml(hit.thumb))
        .split('__TS_FILENAME__').join(escapeHtml(hit.filename))
      tile = tile.replace(
        /data-sub-html="[^"]*"/,
        'data-sub-html="' + subHtml.replace(/"/g, '&quot;') + '"'
      )
      html += tile
    }
    media.innerHTML = html
  }

  function renderHits (hits, terms, scopes, limit) {
    if (hits.length > limit) hits = hits.slice(0, limit)
    if (count) count.textContent = hits.length + (hits.length >= limit ? '+ matches' : ' matches')
    destroyLightGallery()
    renderTilesFromHits(hits, terms, scopes)
    if (hits.length) initLightGallery()
    media.dispatchEvent(new CustomEvent('ts:search-results-rendered', {
      bubbles: true,
      detail: { hitCount: hits.length, query: input.value, scopes: scopes }
    }))
  }

  function showEmptyState (msg) {
    if (count) count.textContent = ''
    destroyLightGallery()
    media.innerHTML = ''
    var note = document.createElement('div')
    note.className = 'ts-empty'
    note.textContent = msg
    media.parentNode.insertBefore(note, media.nextSibling)
    var prev = media.parentNode.querySelectorAll('.ts-empty')
    for (var i = 0; i < prev.length - 1; i++) prev[i].remove()
  }
  function clearEmptyState () {
    var prev = media.parentNode.querySelectorAll('.ts-empty')
    for (var i = 0; i < prev.length; i++) prev[i].remove()
  }

  // ---------- semantic helpers ----------

  function decodeBase64ToFloat32 (b64) {
    var bin = atob(b64)
    var bytes = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Float32Array(bytes.buffer)
  }

  // Cosine similarity = dot product (vectors are normalised at build time).
  function cosineRanks (queryVec, topN) {
    var scored = []
    for (var i = 0; i < embeddingIndexByItem.length; i++) {
      var idx = embeddingIndexByItem[i]
      if (idx < 0) continue
      var off = idx * embedDim
      var s = 0
      for (var d = 0; d < embedDim; d++) s += embeddings[off + d] * queryVec[d]
      scored.push([i, s])
    }
    scored.sort(function (a, b) { return b[1] - a[1] })
    return scored.slice(0, topN)
  }

  // Reciprocal Rank Fusion. Inputs: lists of [itemIndex, score] in
  // ranker-specific score order. Returns [itemIndex, fusedScore], higher
  // = better. k=60 is the standard value from the original RRF paper.
  function rrf (rankers, k) {
    k = k || 60
    var fused = new Map()
    rankers.forEach(function (r) {
      r.forEach(function (entry, rank) {
        var idx = entry[0]
        var score = 1 / (k + rank + 1)
        fused.set(idx, (fused.get(idx) || 0) + score)
      })
    })
    return Array.from(fused.entries())
      .map(function (e) { return [e[0], e[1]] })
      .sort(function (a, b) { return b[1] - a[1] })
  }

  // ---------- query paths ----------

  function bm25Hits (query, scopes, limit) {
    if (!ms) return []
    return ms.search(query, {
      fields: scopes,
      prefix: true,
      fuzzy: 0.2,
      combineWith: 'AND'
    }).slice(0, limit)
  }

  // Returns a Map<id, item> for the items returned by MiniSearch — the
  // items have full storeFields data we need for rendering.
  function bm25HitsAsRanks (query, scopes, limit) {
    var hits = bm25Hits(query, scopes, limit)
    return hits.map(function (h, i) {
      // MiniSearch uses item.id; map back to our items array index by
      // looking it up. Items were added with their original id, so the
      // index in data.items matches insertion order.
      var idx = data.items.findIndex(function (it) { return it.id === h.id })
      return [idx, h.score]
    }).filter(function (e) { return e[0] >= 0 })
  }

  async function runClientQuery (query) {
    var scopes = activeScopes()
    if (!ms || !query || !scopes.length) {
      showEmptyState('Type to search across ' + config.count + ' images.')
      if (count) count.textContent = config.count + ' images'
      return
    }
    clearEmptyState()
    var TOP = 200
    var bm25 = bm25HitsAsRanks(query, scopes, TOP)

    // If the user has explicitly turned off all semantic-bearing fields
    // (Description / OCR), don't bother running semantic — they want the
    // exact-match view.
    var semanticAvailable = embeddings &&
      (scopes.indexOf('aiCaption') >= 0 || scopes.indexOf('aiOcr') >= 0)

    var rankers = [bm25]
    var semanticByIdx = new Map()
    if (semanticAvailable) {
      var embedder = await getEmbedder()
      if (embedder) {
        var out = await embedder(query, { pooling: 'mean', normalize: true })
        var qv = out.data
        var sem = cosineRanks(qv, TOP)
        rankers.push(sem)
        sem.forEach(function (e) { semanticByIdx.set(e[0], e[1]) })
      }
    }

    var fused = rrf(rankers).slice(0, 500)
    var terms = query.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

    // Build the displayable hit objects from the fused index list.
    var bm25Set = new Set(bm25.map(function (e) { return e[0] }))
    var hits = fused.map(function (entry) {
      var item = data.items[entry[0]]
      // Mark a hit as semantic-only if it didn't show up in BM25 — that's
      // the interesting "synonym" case to surface a badge for.
      var isSemantic = !bm25Set.has(entry[0]) && semanticByIdx.has(entry[0])
      return Object.assign({}, item, {
        _semantic: isSemantic,
        _semScore: semanticByIdx.get(entry[0]) || 0
      })
    })

    if (!hits.length) {
      showEmptyState('No matches for "' + query + '".')
      if (count) count.textContent = '0 matches'
      return
    }
    renderHits(hits, terms, scopes, 500)
  }

  var pending = null
  function runServerQuery (query) {
    var scopes = activeScopes()
    if (!query || !scopes.length) {
      showEmptyState('Type to search across ' + config.count + ' images.')
      if (count) count.textContent = config.count + ' images'
      return
    }
    if (pending && pending.abort) pending.abort()
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    pending = ctrl
    var url = config.endpoint + '?q=' + encodeURIComponent(query) +
              '&scopes=' + encodeURIComponent(scopes.join(',')) +
              '&limit=500'
    fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (payload) {
        clearEmptyState()
        var hits = payload.hits || []
        var terms = query.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
        if (!hits.length) {
          showEmptyState('No matches for "' + query + '".')
          if (count) count.textContent = '0 matches'
          return
        }
        renderHits(hits, terms, scopes, 500)
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return
        showEmptyState('Search error: ' + err.message)
      })
  }

  function render (query) {
    if (mode === 'server') runServerQuery(query)
    else runClientQuery(query).catch(function (err) {
      showEmptyState('Search error: ' + err.message)
    })
  }

  var debounceTimer = null
  function scheduleRender () {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(function () {
      render(input.value.trim())
    }, mode === 'server' ? 200 : 100)
  }

  input.addEventListener('input', scheduleRender)
  scopeBoxes.forEach(function (b) { b.addEventListener('change', scheduleRender) })

  var params = new URLSearchParams(window.location.search)
  var initial = params.get('q')
  if (initial) input.value = initial
  render((input.value || '').trim())
})()
