const EventEmitter = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const _ = require('lodash')
const Database = require('better-sqlite3')
const moment = require('moment')
const delta = require('./delta')
const exiftool = require('../exiftool/parallel')
const globber = require('./glob')

const EXIF_DATE_FORMAT = 'YYYY:MM:DD HH:mm:ssZ'

class Index {
  constructor (indexPath) {
    // create the database if it doesn't exist
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })
    this.db = new Database(indexPath, {})
    this.db.exec('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, timestamp INTEGER, metadata BLOB)')
    // Schema migration: add the `size` column if it's not there yet.
    // Rows from an older DB will have size = NULL; we backfill on first index pass.
    const columns = this.db.prepare('PRAGMA table_info(files)').all().map(c => c.name)
    if (!columns.includes('size')) {
      this.db.exec('ALTER TABLE files ADD COLUMN size INTEGER')
    }
  }

  /*
    Index all the files in <media> and store into <database>
  */
  update (mediaFolder, options = {}) {
    // will emit many different events
    const emitter = new EventEmitter()

    // prepared database statements
    const selectStatement = this.db.prepare('SELECT path, timestamp, size FROM files')
    const insertStatement = this.db.prepare('INSERT OR REPLACE INTO files (path, timestamp, size, metadata) VALUES (?, ?, ?, ?)')
    const deleteStatement = this.db.prepare('DELETE FROM files WHERE path = ?')
    const countStatement = this.db.prepare('SELECT COUNT(*) AS count FROM files')
    const selectMetadata = this.db.prepare('SELECT * FROM files')
    const selectOne = this.db.prepare('SELECT * FROM files WHERE path = ?')
    const updatePathStatement = this.db.prepare('UPDATE files SET path = ?, metadata = ? WHERE path = ?')

    // create hashmap of all files in the database
    const databaseMap = {}
    for (const row of selectStatement.iterate()) {
      databaseMap[row.path] = {
        mtime: row.timestamp,
        size: row.size
      }
    }

    const finished = () => {
      // emit every file in the index
      for (const row of selectMetadata.iterate()) {
        emitter.emit('file', {
          path: row.path,
          timestamp: new Date(row.timestamp),
          metadata: JSON.parse(row.metadata)
        })
      }
      // emit the final count
      const result = countStatement.get()
      emitter.emit('done', { count: result.count })
    }

    // find all files on disk
    globber.find(mediaFolder, options, (err, diskMap) => {
      if (err) return console.error('error', err)

      // calculate the difference: which files have been added, modified, etc
      const deltaFiles = delta.calculate(databaseMap, diskMap, options)
      emitter.emit('stats', {
        database: Object.keys(databaseMap).length,
        disk: Object.keys(diskMap).length,
        unchanged: deltaFiles.unchanged.length,
        added: deltaFiles.added.length,
        modified: deltaFiles.modified.length,
        deleted: deltaFiles.deleted.length,
        skipped: deltaFiles.skipped.length,
        moves: deltaFiles.moves.length
      })

      // Apply moves to the DB first: update the path and rewrite the
      // embedded SourceFile field so downstream code sees the new path.
      // Emit 'move' events so the pipeline can rename output files.
      const applyMoves = this.db.transaction(moves => {
        for (const { oldPath, newPath } of moves) {
          const row = selectOne.get(oldPath)
          if (!row) continue
          let metaObj
          try {
            metaObj = JSON.parse(row.metadata)
          } catch (ex) {
            continue
          }
          metaObj.SourceFile = newPath
          // Collision safety: if a row for newPath already exists (shouldn't
          // happen because newPath was in delta.added, meaning not in DB),
          // delete it so the UPDATE doesn't fail on the PRIMARY KEY.
          deleteStatement.run(newPath)
          updatePathStatement.run(newPath, JSON.stringify(metaObj), oldPath)
          emitter.emit('move', { oldPath, newPath })
        }
      })
      if (deltaFiles.moves.length > 0) {
        applyMoves(deltaFiles.moves)
      }

      // remove deleted files from the DB
      _.each(deltaFiles.deleted, path => {
        deleteStatement.run(path)
      })

      // Backfill missing sizes (rows from a pre-migration DB upgraded from
      // upstream thumbsup). Collect first, write after — better-sqlite3
      // doesn't allow running write statements while a SELECT cursor is
      // still open on the same connection.
      const backfills = []
      for (const row of selectStatement.iterate()) {
        if (row.size == null && diskMap[row.path] && diskMap[row.path].size != null) {
          backfills.push({ path: row.path, size: diskMap[row.path].size })
        }
      }
      if (backfills.length > 0) {
        const updateSize = this.db.prepare('UPDATE files SET size = ? WHERE path = ?')
        const tx = this.db.transaction(items => {
          for (const item of items) updateSize.run(item.size, item.path)
        })
        tx(backfills)
      }

      // check if any files need parsing
      let processed = 0
      const toProcess = _.union(deltaFiles.added, deltaFiles.modified)
      if (toProcess.length === 0) {
        return finished()
      }

      // call <exiftool> on added and modified files
      // and write each entry to the database
      const stream = exiftool.parse(mediaFolder, toProcess, options.concurrency)
      stream.on('data', entry => {
        const timestamp = moment(entry.File.FileModifyDate, EXIF_DATE_FORMAT).valueOf()
        const size = diskMap[entry.SourceFile] ? diskMap[entry.SourceFile].size : null
        insertStatement.run(entry.SourceFile, timestamp, size, JSON.stringify(entry))
        ++processed
        emitter.emit('progress', { path: entry.SourceFile, processed, total: toProcess.length })
      }).on('end', finished)
    })

    return emitter
  }

  /*
    Do a full vacuum to optimise the database
    which can be needed if files are often deleted/modified
  */
  vacuum () {
    this.db.exec('VACUUM')
  }
}

module.exports = Index
