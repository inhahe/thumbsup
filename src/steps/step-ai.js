/*
--------------------------------------------------------------------------------
Runs AI captioning (BLIP) and OCR (Tesseract) for every image.
Results are cached in the thumbsup database between runs.
--------------------------------------------------------------------------------
*/

const Observable = require('zen-observable')
const info = require('debug')('thumbsup:info')
const AIDescriber = require('../components/ai/ai')

// Pretty label for BLIP's compute device — surfaced in the Listr task
// title so the user notices when they're falling back to CPU (which is
// roughly 10-30x slower per image than CUDA).
function deviceLabel (device) {
  if (!device || device === 'unknown') return ''
  if (device === 'cuda') return 'GPU'
  if (device === 'cpu') return 'CPU'
  return device
}

exports.run = function (files, opts) {
  return new Observable(observer => {
    const describer = new AIDescriber(opts.databaseFile, opts)
    const emitter = describer.run(files, opts.input)

    let label = ''
    let warned = false

    emitter.on('ready', evt => {
      label = deviceLabel(evt.device)
      // One-time advisory if we're on CPU. Tesseract is CPU-only by
      // design so we don't suggest GPU upgrade purely on its account, but
      // BLIP and EasyOCR both follow torch.cuda — if either of them are
      // CPU it's because no CUDA-capable torch was found.
      if (!warned) {
        warned = true
        const parts = []
        if (evt.captioner) parts.push(`BLIP on ${deviceLabel(evt.captionerDevice)}`)
        if (evt.ocr) parts.push(`OCR (${evt.ocrEngine}) on ${deviceLabel(evt.ocrDevice)}`)
        if (evt.embed) parts.push(`embed (${evt.embedModel.split('/').pop()}, dim=${evt.embedDim}) on ${deviceLabel(evt.embedDevice)}`)
        info(`AI: ${parts.join(', ')}`)
        const blipCpu = evt.captioner && evt.captionerDevice === 'cpu'
        const easyOnCpu = evt.ocr && evt.ocrEngine === 'easyocr' && evt.ocrDevice === 'cpu'
        const embedCpu = evt.embed && evt.embedDevice === 'cpu'
        if (blipCpu || easyOnCpu || embedCpu) {
          info('AI: no CUDA-capable GPU detected. Expect ~1-3s per image on CPU; a GPU + CUDA-enabled torch is ~10-30x faster.')
        }
      }
    })

    emitter.on('progress', stats => {
      const where = label ? ` on ${label}` : ''
      if (stats.total === 0) {
        observer.next(`No new images to describe${where}`)
      } else {
        const pct = Math.floor(stats.processed * 100 / stats.total)
        observer.next(`Describing${where} ${stats.processed}/${stats.total} (${pct}%)`)
      }
    })

    emitter.on('error', err => observer.error(err))
    emitter.on('done', () => observer.complete())
  })
}
