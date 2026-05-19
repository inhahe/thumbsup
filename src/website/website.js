const fs = require('node:fs')
const path = require('node:path')
const async = require('async')
const resolvePkg = require('resolve-pkg')
const Theme = require('./theme')
const SEO = require('./seo')
const pages = require('./pages')
const searchIndex = require('./search-index')

exports.build = function (rootAlbum, opts, callback) {
  // create the base layer assets
  // such as shared JS libs, common handlebars helpers, CSS reset...
  const baseDir = path.join(__dirname, 'theme-base')
  const base = new Theme(baseDir, opts.output, {
    stylesheetName: 'core.css'
  })

  // then create the actual theme assets
  const themeDir = opts.themePath || localThemePath(opts.theme)
  const theme = new Theme(themeDir, opts.output, {
    stylesheetName: 'theme.css',
    customStylesPath: opts.themeStyle
  })

  // data passed to the template
  const themeSettings = readThemeSettings(opts.themeSettings)

  // create the rendering tasks
  const viewModels = pages.create(rootAlbum, opts, themeSettings)
  const tasks = viewModels.map(model => {
    return next => theme.render(model.path, model, next)
  })

  // write the search assets. In client mode that's the MiniSearch index; in
  // server mode that invokes Python to build a Whoosh index on disk.
  searchIndex.write(rootAlbum, opts.output, opts)

  // The search page is rendered through the theme's handlebars pipeline so
  // it inherits the theme's look and shared partials. If the user's theme
  // doesn't ship a search.hbs, fall back to the base theme's generic one.
  //
  // Detect lightGallery so the fallback search page can opt into the same
  // lightbox behaviour the theme's album pages use. All four built-in
  // thumbsup themes (classic, cards, mosaic, flow) ship lightGallery at
  // identical paths under public/lightgallery/. Custom themes that use a
  // different lightbox can either bring their own search.hbs or omit
  // lightGallery — search.js degrades to plain link-click navigation.
  const themeDirResolved = opts.themePath || localThemePath(opts.theme)
  const themeHasLightgallery = fs.existsSync(
    path.join(themeDirResolved, 'public', 'lightgallery', 'js', 'lightgallery-all.min.js')
  ) || fs.existsSync(
    path.join(themeDirResolved, 'public', 'lightgallery', 'js', 'lightgallery.min.js')
  )
  //
  // `searchTile` is a placeholder file passed to {{> thumbnail}} inside a
  // hidden <template>. JS clones the rendered markup per search hit and
  // substitutes these sentinel strings with the hit's real values. Using
  // sentinels (vs leaving fields empty) lets us keep the substitution to
  // a few `replaceAll` calls in the browser.
  const searchModel = {
    gallery: Object.assign({}, opts, { home: rootAlbum }),
    settings: themeSettings,
    home: rootAlbum,
    album: { path: 'search.html' },
    themeHasLightgallery,
    searchTile: {
      id: 'TPL',
      filename: '__TS_FILENAME__',
      isVideo: false,
      urls: {
        thumbnail: '__TS_THUMB__',
        small: '__TS_THUMB__',
        large: '__TS_LARGE__',
        download: '__TS_LARGE__'
      },
      meta: { caption: '', animated: false }
    }
  }

  // now build everything
  async.series([
    next => base.prepare(next),
    next => theme.prepare(next),
    next => async.series(tasks, next),
    next => {
      const rendered = theme.renderSearch('search.html', searchModel, next) ||
        base.renderSearch('search.html', searchModel, next)
      if (!rendered) next()
    }
  ], callback)

  // add robots & sitemap if needed
  if (opts.seoLocation) {
    const seo = new SEO(opts.output, opts.seoLocation, rootAlbum)
    seo.writeFiles()
  }
}

function localThemePath (themeName) {
  const local = resolvePkg(`@thumbsup/theme-${themeName}`, { cwd: __dirname })
  if (!local) {
    throw new Error(`Could not find a built-in theme called ${themeName}`)
  }
  return local
}

function readThemeSettings (filepath) {
  if (!filepath) {
    return {}
  }
  const content = fs.readFileSync(filepath).toString()
  try {
    return JSON.parse(content)
  } catch (ex) {
    throw new Error('Failed to parse JSON theme settings file: ' + filepath)
  }
}
