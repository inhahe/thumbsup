/*
--------------------------------------------------------------------------------
For each (oldPath -> newPath) source move detected by the index, rename the
corresponding media output files (thumbnails, small, large, download, copies)
so they don't need to be regenerated. Album HTML pages are rebuilt every run
regardless, so we only have to worry about the expensive media outputs.
--------------------------------------------------------------------------------
*/

const path = require('node:path')
const fs = require('node:fs')
const Observable = require('zen-observable')
const debug = require('debug')('thumbsup:debug')
const output = require('../model/output')

exports.run = function (files, moves, opts) {
  return new Observable(observer => {
    if (!moves || moves.length === 0) {
      observer.complete()
      return
    }

    // Build a lookup: new source path -> File (gives us .type and new .output paths)
    const byNewPath = new Map()
    for (const f of files) byNewPath.set(f.path, f)

    let reused = 0
    let missing = 0
    // Track directories we emptied so we can try to clean them up at the end.
    // Using a Set so we only try each once, and iterating deepest-first later.
    const maybeEmpty = new Set()
    for (let i = 0; i < moves.length; i++) {
      const { oldPath, newPath } = moves[i]
      observer.next(`Reusing outputs ${i + 1}/${moves.length}`)
      const file = byNewPath.get(newPath)
      if (!file) continue
      const oldOutputs = output.paths(oldPath, file.type, opts)
      const newOutputs = file.output
      for (const key of Object.keys(newOutputs)) {
        const oldRel = oldOutputs[key] && oldOutputs[key].path
        const newRel = newOutputs[key] && newOutputs[key].path
        if (!oldRel || !newRel || oldRel === newRel) continue
        // Skip relationships that don't produce files in <output> (e.g. external links)
        const rel = newOutputs[key].rel
        if (rel === 'fs:link') continue
        const oldAbs = path.join(opts.output, oldRel)
        const newAbs = path.join(opts.output, newRel)
        if (!fs.existsSync(oldAbs)) { missing++; continue }
        if (fs.existsSync(newAbs)) { continue } // don't clobber
        try {
          fs.mkdirSync(path.dirname(newAbs), { recursive: true })
          fs.renameSync(oldAbs, newAbs)
          reused++
          maybeEmpty.add(path.dirname(oldAbs))
          debug(`Moved output ${oldRel} -> ${newRel}`)
        } catch (ex) {
          // If renameSync fails across filesystems, fall back to copy + unlink
          try {
            fs.copyFileSync(oldAbs, newAbs)
            fs.unlinkSync(oldAbs)
            reused++
            maybeEmpty.add(path.dirname(oldAbs))
          } catch (ex2) {
            debug(`Failed to move ${oldAbs} -> ${newAbs}: ${ex2.message}`)
          }
        }
      }
    }

    // Clean up now-empty source directories. Do deepest first so that parent
    // dirs can also be removed once their children are gone. rmdir will fail
    // on non-empty dirs, which is fine — we just swallow the error.
    const dirsDeepFirst = Array.from(maybeEmpty).sort((a, b) => b.length - a.length)
    for (const dir of dirsDeepFirst) {
      pruneEmpty(dir, opts.output)
    }

    observer.next(`Reused ${reused} output files (${missing} missing)`)
    observer.complete()
  })
}

// rmdir <dir> and walk upward while each parent is both inside the output
// root and empty. Stops at the output root itself.
function pruneEmpty (dir, outputRoot) {
  const absRoot = path.resolve(outputRoot)
  let current = path.resolve(dir)
  while (current.startsWith(absRoot) && current !== absRoot) {
    try {
      fs.rmdirSync(current)
    } catch (ex) {
      return
    }
    current = path.dirname(current)
  }
}
