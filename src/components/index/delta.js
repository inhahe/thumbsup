/* eslint-disable no-prototype-builtins */
const path = require('node:path')
const _ = require('lodash')
const GlobPattern = require('./pattern')

/*
  Calculate the difference between files on disk and already indexed.
  - databaseMap: { path: { mtime, size } }
  - diskMap:     { path: { mtime, size } }
  Output includes a `moves` list so that callers can reuse already-processed
  outputs instead of regenerating them. Moves are detected by matching a
  deleted path to an added path with the same basename + file size: cheap,
  and accurate enough in practice (user accepts that pure renames will not
  be detected and will fall through to normal regeneration).
*/
exports.calculate = (databaseMap, diskMap, { scanMode = 'full', include, exclude }) => {
  const delta = {
    unchanged: [],
    added: [],
    modified: [],
    deleted: [],
    skipped: [],
    moves: [] // [{ oldPath, newPath, size }]
  }
  // TODO: the glob pattern should be passed in
  // It should be identical to the one used by the Glob object that scans the disk
  // For now, partial scans only uses the include/exclude filter
  // If we pass it it, other filters would apply as well (e.g. photo/video/raw...)
  const pattern = new GlobPattern({ include, exclude, extensions: [] })
  // Normalize legacy callers that pass { path: mtimeNumber } instead of
  // { path: { mtime, size } } (e.g. older tests).
  const db = normalize(databaseMap)
  const disk = normalize(diskMap)
  _.each(db, (dbEntry, dbPath) => {
    const shouldProcessDBEntry = (scanMode === 'full') ? true : pattern.match(dbPath)
    if (shouldProcessDBEntry) {
      if (disk.hasOwnProperty(dbPath)) {
        const modified = Math.abs(dbEntry.mtime - disk[dbPath].mtime) > 1000
        if (modified) {
          delta.modified.push(dbPath)
        } else {
          delta.unchanged.push(dbPath)
        }
      } else {
        if (scanMode === 'incremental') {
          delta.skipped.push(dbPath)
        } else {
          delta.deleted.push(dbPath)
        }
      }
    } else {
      delta.skipped.push(dbPath)
    }
  })
  _.each(disk, (diskEntry, diskPath) => {
    if (!db.hasOwnProperty(diskPath)) {
      delta.added.push(diskPath)
    }
  })

  // Detect moves: a file was "deleted" from one path and "added" at another
  // with the same basename + size. Ambiguous matches (multiple deleted files
  // with the same basename+size, or multiple added ones) are skipped — those
  // fall through to normal add/delete handling.
  if (delta.deleted.length > 0 && delta.added.length > 0) {
    const deletedByKey = new Map() // key -> [path, path, ...]
    for (const p of delta.deleted) {
      const dbEntry = db[p]
      if (dbEntry == null || dbEntry.size == null) continue
      const key = moveKey(p, dbEntry.size)
      if (!deletedByKey.has(key)) deletedByKey.set(key, [])
      deletedByKey.get(key).push(p)
    }
    const addedByKey = new Map()
    for (const p of delta.added) {
      const diskEntry = disk[p]
      if (diskEntry == null || diskEntry.size == null) continue
      const key = moveKey(p, diskEntry.size)
      if (!addedByKey.has(key)) addedByKey.set(key, [])
      addedByKey.get(key).push(p)
    }
    const movedAdded = new Set()
    const movedDeleted = new Set()
    for (const [key, oldPaths] of deletedByKey.entries()) {
      const newPaths = addedByKey.get(key)
      if (!newPaths) continue
      if (oldPaths.length !== 1 || newPaths.length !== 1) continue
      delta.moves.push({
        oldPath: oldPaths[0],
        newPath: newPaths[0],
        size: disk[newPaths[0]].size
      })
      movedDeleted.add(oldPaths[0])
      movedAdded.add(newPaths[0])
    }
    // Remove matched moves from the added/deleted lists
    delta.deleted = delta.deleted.filter(p => !movedDeleted.has(p))
    delta.added = delta.added.filter(p => !movedAdded.has(p))
  }

  return delta
}

function moveKey (filepath, size) {
  return path.basename(filepath) + '\0' + size
}

function normalize (map) {
  const out = {}
  for (const k of Object.keys(map)) {
    const v = map[k]
    if (typeof v === 'number') {
      out[k] = { mtime: v, size: null }
    } else if (v && typeof v === 'object') {
      out[k] = { mtime: v.mtime, size: (v.size == null ? null : v.size) }
    } else {
      out[k] = { mtime: 0, size: null }
    }
  }
  return out
}
/* eslint-enable no-prototype-builtins */
