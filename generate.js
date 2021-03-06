#!/usr/bin/env node
const AJV = require('ajv')
const commonmark = require('commonform-commonmark')
const docx = require('commonform-docx')
const ejs = require('ejs')
const fs = require('fs')
const glob = require('glob')
const grayMatter = require('gray-matter')
const hash = require('commonform-hash')
const loadComponents = require('commonform-load-components')
const markdown = require('./markdown')
const ooxmlSignaturePages = require('ooxml-signature-pages')
const path = require('path')
const revedCompare = require('reviewers-edition-compare')
const revedSpell = require('reviewers-edition-spell')
const rimraf = require('rimraf')
const runSeries = require('run-series')
const toHTML = require('commonform-html')

const numberings = {
  decimal: require('decimal-numbering'),
  outline: require('outline-numbering'),
  rse: require('resolutions-schedules-exhibits-numbering'),
  ase: require('agreement-schedules-exhibits-numbering'),
}

const ajv = new AJV()
const validateFrontMatter = ajv.compile(
  require('./schemas/front-matter'),
)
const validateProject = ajv.compile(require('./schemas/project'))
const validatePublisher = ajv.compile(
  require('./schemas/publisher'),
)

rimraf.sync('site')

fs.mkdirSync('site', { recursive: true })

const templates = {}
glob.sync('templates/*.ejs').forEach((file) => {
  const basename = path.basename(file, '.ejs')
  templates[basename] = fs.readFileSync(file, 'utf8')
})

const publishers = {}

const markdownFiles = glob.sync('forms/*/*/*.md')
const formFiles = markdownFiles.filter((file) => {
  return path.basename(file) !== 'index.md'
})
const indexFiles = markdownFiles.filter((file) => {
  return path.basename(file) === 'index.md'
})

const forms = formFiles.map((file) => {
  const contents = fs.readFileSync(file, 'utf8')
  const parsed = grayMatter(contents)
  const markup = parsed.content
  const frontMatter = parsed.data
  if (!validateFrontMatter(frontMatter)) {
    console.error(validateFrontMatter.errors)
    throw new Error(`invalid front matter: ${file}`)
  }
  const form = commonmark.parse(markup).form
  const dirname = path.dirname(file)
  const [_, publisher, project] = dirname.split(path.sep)
  const edition = path.basename(file, '.md')
  return {
    publisher,
    project,
    edition,
    frontMatter,
    digest: hash(form),
    form,
  }
})

function getForm(repository, digest, callback) {
  if (repository !== 'commonform.org')
    return callback(
      new Error(`invalid repository: ${repository}`),
    )
  const result = forms.find((element) => {
    return element.digest === digest
  })
  callback(null, result ? result.form : false)
}

function getPublication(
  repository,
  publisher,
  project,
  edition,
  callback,
) {
  if (repository !== 'commonform.org')
    return callback(
      new Error(`invalid repository: ${repository}`),
    )
  const publication = forms.find((element) => {
    return (
      element.publisher === publisher &&
      element.project === project &&
      element.edition === edition
    )
  })
  const result = publication
    ? { digest: publication.digest }
    : false
  callback(null, result)
}

function getEditions(repository, publisher, project, callback) {
  if (repository !== 'commonform.org')
    return callback(
      new Error(`invalid repository: ${repository}`),
    )
  const editions = forms
    .filter((element) => {
      return (
        element.publisher === publisher &&
        element.project === project
      )
    })
    .map((element) => element.edition)
  const result = editions.length > 0 ? editions : false
  callback(null, result)
}

const loadOptions = {
  repositories: ['commonform.org'],
  caches: {
    editions: { get: getEditions },
    publications: { get: getPublication },
    forms: { get: getForm },
  },
}

const projectMetadata = {}

indexFiles.forEach((projectFile) => {
  const contents = fs.readFileSync(projectFile)
  const parsed = grayMatter(contents)
  const meta = parsed.data
  meta.description = markdown(parsed.content)
  if (!validateProject(meta)) {
    console.error(validateProject.errors)
    throw new Error(`invalid project meta: ${projectFile}`)
  }
  const [_, publisher, project] = projectFile
    .replace('.json', '')
    .split(path.sep)
  if (!projectMetadata[publisher]) {
    projectMetadata[publisher] = {}
  }
  projectMetadata[publisher][project] = meta
})

const publisherFiles = glob.sync('forms/*/index.md')

const publisherMetadata = {}

publisherFiles.forEach((file) => {
  const contents = fs.readFileSync(file)
  const parsed = grayMatter(contents)
  const meta = parsed.data
  meta.about = markdown(parsed.content)
  if (!validatePublisher(meta)) {
    console.error(validatePublisher.errors)
    throw new Error(`invalid publisher meta: ${file}`)
  }
  const [_, publisher] = path.dirname(file).split(path.sep)
  if (!publisherMetadata[publisher]) {
    publisherMetadata[publisher] = meta
  }
})

runSeries(
  formFiles.map((file) => {
    return (done) => {
      const contents = fs.readFileSync(file, 'utf8')
      const parsed = grayMatter(contents)
      const markup = parsed.content
      const frontMatter = parsed.data
      if (!validateFrontMatter(frontMatter)) {
        console.error(validateFrontMatter.errors)
        throw new Error(`invalid front matter: ${file}`)
      }
      const form = commonmark.parse(markup).form
      loadComponents(
        clone(form),
        loadOptions,
        (error, loaded, resolutions) => {
          if (error) throw error
          const rendered = toHTML(loaded, [], {
            html5: true,
            lists: true,
            ids: true,
          })
          const dirname = path.dirname(file)
          const [_, publisher, project] = dirname.split(path.sep)
          const edition = path.basename(file, '.md')
          const title = frontMatter.title || project
          const data = Object.assign(
            {
              title,
              github: `https://github.com/commonform/commonform-static/blob/master/${file}`,
              digest: hash(form),
              docx: `${edition}.docx`,
              json: `${edition}.json`,
              markdown: `${edition}.md`,
              spelled: revedSpell(edition),
              project,
              projectMetadata:
                projectMetadata[publisher][project],
              notes: false,
              publisher,
              publisherMetadata: publisherMetadata[publisher],
              rendered,
              edition,
            },
            frontMatter,
          )
          let html
          try {
            html = ejs.render(templates.form, data)
          } catch (error) {
            throw new Error(`${file}: ${error.message}`)
          }
          const page = path.join(
            'site',
            publisher,
            project,
            `${edition}.html`,
          )
          fs.mkdirSync(path.dirname(page), { recursive: true })
          fs.writeFileSync(page, html)
          if (!publishers[publisher]) {
            publishers[publisher] = {
              publisher,
              projects: {},
            }
          }
          if (!publishers[publisher].projects[project]) {
            publishers[publisher].projects[
              project
            ] = Object.assign(
              {
                editions: {},
              },
              projectMetadata[publisher][project],
            )
          }
          publishers[publisher].projects[project].editions[
            edition
          ] = frontMatter
          docx(loaded, [], {
            title,
            edition,
            centerTitle: false,
            indentMargins: true,
            markFilled: true,
            numbering:
              numberings[frontMatter.numbering || 'outline'],
            after: frontMatter.signaturePages
              ? ooxmlSignaturePages(frontMatter.signaturePages)
              : false,
            styles: frontMatter.styles || {
              alignment: 'left',
              heading: {
                italic: true,
              },
              reference: {
                italic: true,
              },
              referenceHeading: {
                italic: true,
              },
            },
          })
            .generateAsync({ type: 'nodebuffer' })
            .then((buffer) => {
              const wordFile = path.join(
                'site',
                publisher,
                project,
                `${edition}.docx`,
              )
              fs.writeFileSync(wordFile, buffer)
            })

          const jsonFile = path.join(
            'site',
            publisher,
            project,
            `${edition}.json`,
          )
          fs.writeFileSync(
            jsonFile,
            JSON.stringify(
              Object.assign({}, frontMatter, { form }),
            ),
          )

          const markdownFile = path.join(
            'site',
            publisher,
            project,
            `${edition}.md`,
          )
          fs.writeFileSync(markdownFile, markup)
          done()
        },
      )
    }
  }),
  () => {
    renderPublisherPages()
    renderHomePage()
  },
)

function renderPublisherPages() {
  Object.keys(publishers).forEach((publisher) => {
    const projects = publishers[publisher].projects

    renderPublisherPage()
    renderProjectsPages()

    function renderPublisherPage() {
      const publisherPage = path.join(
        'site',
        publisher,
        'index.html',
      )
      const data = Object.assign(
        {
          email: false,
          website: false,
          location: false,
          hasBuildingBlocks: Object.keys(projects).some(
            (key) => {
              return projects[key].buildingBlock === true
            },
          ),
          hasCompleteForms: Object.keys(projects).some((key) => {
            return projects[key].buildingBlock === false
          }),
        },
        publisherMetadata[publisher],
        publishers[publisher],
      )
      const html = ejs.render(templates.publisher, data)
      fs.writeFileSync(publisherPage, html)
    }

    function renderProjectsPages() {
      Object.keys(projects).forEach((project) => {
        const projectPage = path.join(
          'site',
          publisher,
          project,
          'index.html',
        )
        const editions = Object.keys(projects[project].editions)
          .map((edition) => {
            const frontMatter =
              projects[project].editions[edition]
            return {
              number: edition,
              spelled: revedSpell(edition),
              frontMatter,
            }
          })
          .sort((a, b) => {
            return revedCompare(a.edition, b.edition)
          })
        const data = Object.assign(
          {
            publisher,
            project,
            editions,
          },
          projectMetadata[publisher][project],
        )
        const html = ejs.render(templates.project, data)
        fs.writeFileSync(projectPage, html)
      })
    }
  })
}

function renderHomePage() {
  const page = path.join('site', 'index.html')
  const data = {
    publishers: Object.keys(publishers)
      .map((publisher) => {
        return Object.assign(
          { name: publisher },
          publisherMetadata[publisher],
        )
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
  const html = ejs.render(templates.home, data)
  fs.writeFileSync(page, html)
}

glob.sync('static/*').forEach((file) => {
  const basename = path.basename(file)
  fs.copyFileSync(file, path.join('site', basename))
})

function clone(x) {
  return JSON.parse(JSON.stringify(x))
}
