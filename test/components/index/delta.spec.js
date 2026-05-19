const delta = require('../../../src/components/index/delta')
const should = require('should/as-function')

describe('Index: delta', () => {
  describe('Scan mode: full', () => {
    it('no changes', () => {
      const database = {
        IMG_0001: 1410000000000,
        IMG_0002: 1420000000000
      }
      const disk = {
        IMG_0001: 1410000000000,
        IMG_0002: 1420000000000
      }
      const res = delta.calculate(database, disk, {})
      should(res).eql({
        unchanged: ['IMG_0001', 'IMG_0002'],
        added: [],
        modified: [],
        deleted: [],
        skipped: [],
        moves: []
      })
    })

    it('no changes within a second', () => {
      const database = {
        IMG_0001: 1410000001000,
        IMG_0002: 1420000001000
      }
      const disk = {
        IMG_0001: 1410000001500, // 500ms later
        IMG_0002: 1420000000500 // 500ms earlier
      }
      const res = delta.calculate(database, disk, {})
      should(res).eql({
        unchanged: ['IMG_0001', 'IMG_0002'],
        added: [],
        modified: [],
        deleted: [],
        skipped: [],
        moves: []
      })
    })

    it('new files', () => {
      const database = {
        IMG_0001: 1410000000000,
        IMG_0002: 1420000000000
      }
      const disk = {
        IMG_0001: 1410000000000,
        IMG_0002: 1420000000000,
        IMG_0003: 1430000000000
      }
      const res = delta.calculate(database, disk, {})
      should(res).eql({
        unchanged: ['IMG_0001', 'IMG_0002'],
        added: ['IMG_0003'],
        modified: [],
        deleted: [],
        skipped: [],
        moves: []
      })
    })

    it('deleted files', () => {
      const database = {
        IMG_0001: 1410000000000,
        IMG_0002: 1420000000000
      }
      const disk = {
        IMG_0001: 1410000000000
      }
      const res = delta.calculate(database, disk, {})
      should(res).eql({
        unchanged: ['IMG_0001'],
        added: [],
        modified: [],
        deleted: ['IMG_0002'],
        skipped: [],
        moves: []
      })
    })

    it('modified files', () => {
      const database = {
        IMG_0001: 1410000000000,
        IMG_0002: 1420000000000
      }
      const disk = {
        IMG_0001: 1410000000000,
        IMG_0002: 1420000002000
      }
      const res = delta.calculate(database, disk, {})
      should(res).eql({
        unchanged: ['IMG_0001'],
        added: [],
        modified: ['IMG_0002'],
        deleted: [],
        skipped: [],
        moves: []
      })
    })

    it('all cases', () => {
      const database = {
        IMG_0001: 1410000000000,
        IMG_0002: 1420000000000,
        IMG_0003: 1430000000000
      }
      const disk = {
        IMG_0001: 1410000000000,
        IMG_0002: 1420000002000,
        IMG_0004: 1445000000000
      }
      const res = delta.calculate(database, disk, {})
      should(res).eql({
        unchanged: ['IMG_0001'],
        added: ['IMG_0004'],
        modified: ['IMG_0002'],
        deleted: ['IMG_0003'],
        skipped: [],
        moves: []
      })
    })
  })

  describe('Move detection', () => {
    it('detects a file moved to a new directory (same basename + size)', () => {
      const database = {
        'old/IMG_0001.jpg': { mtime: 1410000000000, size: 12345 }
      }
      const disk = {
        'new/IMG_0001.jpg': { mtime: 1410000000000, size: 12345 }
      }
      const res = delta.calculate(database, disk, {})
      should(res).eql({
        unchanged: [],
        added: [],
        modified: [],
        deleted: [],
        skipped: [],
        moves: [{ oldPath: 'old/IMG_0001.jpg', newPath: 'new/IMG_0001.jpg', size: 12345 }]
      })
    })

    it('does not detect a move when sizes differ', () => {
      const database = {
        'old/IMG_0001.jpg': { mtime: 1410000000000, size: 12345 }
      }
      const disk = {
        'new/IMG_0001.jpg': { mtime: 1410000000000, size: 99999 }
      }
      const res = delta.calculate(database, disk, {})
      should(res.moves).eql([])
      should(res.deleted).eql(['old/IMG_0001.jpg'])
      should(res.added).eql(['new/IMG_0001.jpg'])
    })

    it('does not detect a move when basenames differ', () => {
      const database = {
        'a/IMG_0001.jpg': { mtime: 1410000000000, size: 12345 }
      }
      const disk = {
        'a/IMG_0002.jpg': { mtime: 1410000000000, size: 12345 }
      }
      const res = delta.calculate(database, disk, {})
      should(res.moves).eql([])
    })

    it('skips ambiguous matches where two files share basename + size', () => {
      const database = {
        'a/IMG_0001.jpg': { mtime: 1410000000000, size: 12345 },
        'b/IMG_0001.jpg': { mtime: 1410000000000, size: 12345 }
      }
      const disk = {
        'c/IMG_0001.jpg': { mtime: 1410000000000, size: 12345 }
      }
      const res = delta.calculate(database, disk, {})
      // ambiguous -> fall through to regular add/delete
      should(res.moves).eql([])
      should(res.deleted.sort()).eql(['a/IMG_0001.jpg', 'b/IMG_0001.jpg'])
      should(res.added).eql(['c/IMG_0001.jpg'])
    })
  })

  describe('Scan mode: partial', () => {
    it('considers deleted files outside the inclusion pattern as skipped', () => {
      const database = {
        'London/IMG_0001': 1410000000000,
        'Tokyo/IMG_0002': 1420000000000
      }
      const disk = {
        'London/IMG_0001': 1410000000000
      }
      const res = delta.calculate(database, disk, {
        scanMode: 'incremental',
        include: ['London/**'],
        exclude: []
      })
      should(res).eql({
        unchanged: ['London/IMG_0001'],
        added: [],
        modified: [],
        deleted: [],
        skipped: ['Tokyo/IMG_0002'],
        moves: []
      })
    })

    it('considers deleted files matching an exclusion pattern as skipped', () => {
      const database = {
        'London/IMG_0001': 1410000000000,
        'Tokyo/IMG_0002': 1420000000000
      }
      const disk = {
        'London/IMG_0001': 1410000000000
      }
      const res = delta.calculate(database, disk, {
        scanMode: 'incremental',
        include: [],
        exclude: ['Tokyo/**']
      })
      should(res).eql({
        unchanged: ['London/IMG_0001'],
        added: [],
        modified: [],
        deleted: [],
        skipped: ['Tokyo/IMG_0002'],
        moves: []
      })
    })

    it('considers files inside the inclusion pattern as deleted', () => {
      const database = {
        'London/IMG_0001': 1410000000000,
        'Tokyo/IMG_0002': 1420000000000
      }
      const disk = {
        'London/IMG_0001': 1410000000000
      }
      const res = delta.calculate(database, disk, {
        scanMode: 'partial',
        include: ['**/**'],
        exclude: []
      })
      should(res).eql({
        unchanged: ['London/IMG_0001'],
        added: [],
        modified: [],
        deleted: ['Tokyo/IMG_0002'],
        skipped: [],
        moves: []
      })
    })
  })

  describe('Scan mode: incremental', () => {
    it('considers files inside the inclusion pattern as skipped', () => {
      const database = {
        'London/IMG_0001': 1410000000000,
        'Tokyo/IMG_0002': 1420000000000
      }
      const disk = {
        'London/IMG_0001': 1410000000000
      }
      const res = delta.calculate(database, disk, {
        scanMode: 'incremental',
        include: [],
        exclude: []
      })
      should(res).eql({
        unchanged: ['London/IMG_0001'],
        added: [],
        modified: [],
        deleted: [],
        skipped: ['Tokyo/IMG_0002'],
        moves: []
      })
    })
  })
})
