/* eslint-env jest */
/* global jasmine */
import http from 'http'
import url from 'url'
import stripAnsi from 'strip-ansi'
import fs from 'fs-extra'
import { join } from 'path'
import cheerio from 'cheerio'
import webdriver from 'next-webdriver'
import {
  launchApp,
  killApp,
  findPort,
  nextBuild,
  nextStart,
  fetchViaHTTP,
  renderViaHTTP,
  getBrowserBodyText,
  waitFor,
  normalizeRegEx,
  initNextServerScript,
} from 'next-test-utils'

jasmine.DEFAULT_TIMEOUT_INTERVAL = 1000 * 60 * 2

let appDir = join(__dirname, '..')
const nextConfigPath = join(appDir, 'next.config.js')
let externalServerHits = new Set()
let nextConfigRestoreContent
let nextConfigContent
let externalServerPort
let externalServer
let stdout = ''
let buildId
let appPort
let app

const runTests = (isDev = false) => {
  it('should handle one-to-one rewrite successfully', async () => {
    const html = await renderViaHTTP(appPort, '/first')
    expect(html).toMatch(/hello/)
  })

  it('should handle chained rewrites successfully', async () => {
    const html = await renderViaHTTP(appPort, '/')
    expect(html).toMatch(/multi-rewrites/)
  })

  it('should not match dynamic route immediately after applying header', async () => {
    const res = await fetchViaHTTP(appPort, '/blog/post-321')
    expect(res.headers.get('x-something')).toBe('applied-everywhere')

    const $ = cheerio.load(await res.text())
    expect(JSON.parse($('p').text()).path).toBe('blog')
  })

  it('should handle chained redirects successfully', async () => {
    const res1 = await fetchViaHTTP(appPort, '/redir-chain1', undefined, {
      redirect: 'manual',
    })
    const res1location = url.parse(res1.headers.get('location')).pathname
    expect(res1.status).toBe(301)
    expect(res1location).toBe('/redir-chain2')

    const res2 = await fetchViaHTTP(appPort, res1location, undefined, {
      redirect: 'manual',
    })
    const res2location = url.parse(res2.headers.get('location')).pathname
    expect(res2.status).toBe(302)
    expect(res2location).toBe('/redir-chain3')

    const res3 = await fetchViaHTTP(appPort, res2location, undefined, {
      redirect: 'manual',
    })
    const res3location = url.parse(res3.headers.get('location')).pathname
    expect(res3.status).toBe(303)
    expect(res3location).toBe('/')
  })

  it('should redirect successfully with permanent: false', async () => {
    const res = await fetchViaHTTP(appPort, '/redirect1', undefined, {
      redirect: 'manual',
    })
    const { pathname } = url.parse(res.headers.get('location'))
    expect(res.status).toBe(307)
    expect(pathname).toBe('/')
  })

  it('should redirect with params successfully', async () => {
    const res = await fetchViaHTTP(appPort, '/hello/123/another', undefined, {
      redirect: 'manual',
    })
    const { pathname } = url.parse(res.headers.get('location'))
    expect(res.status).toBe(307)
    expect(pathname).toBe('/blog/123')
  })

  it('should redirect with hash successfully', async () => {
    const res = await fetchViaHTTP(
      appPort,
      '/docs/router-status/500',
      undefined,
      {
        redirect: 'manual',
      }
    )
    const { pathname, hash, query } = url.parse(
      res.headers.get('location'),
      true
    )
    expect(res.status).toBe(301)
    expect(pathname).toBe('/docs/v2/network/status-codes')
    expect(hash).toBe('#500')
    expect(query).toEqual({})
  })

  it('should redirect successfully with provided statusCode', async () => {
    const res = await fetchViaHTTP(appPort, '/redirect2', undefined, {
      redirect: 'manual',
    })
    const { pathname, query } = url.parse(res.headers.get('location'), true)
    expect(res.status).toBe(301)
    expect(pathname).toBe('/')
    expect(query).toEqual({})
  })

  it('should redirect successfully with catchall', async () => {
    const res = await fetchViaHTTP(
      appPort,
      '/catchall-redirect/hello/world',
      undefined,
      {
        redirect: 'manual',
      }
    )
    const { pathname, query } = url.parse(res.headers.get('location'), true)
    expect(res.status).toBe(307)
    expect(pathname).toBe('/somewhere')
    expect(query).toEqual({})
  })

  it('should server static files through a rewrite', async () => {
    const text = await renderViaHTTP(appPort, '/hello-world')
    expect(text).toBe('hello world!')
  })

  it('should rewrite with params successfully', async () => {
    const html = await renderViaHTTP(appPort, '/test/hello')
    expect(html).toMatch(/Hello/)
  })

  it('should double redirect successfully', async () => {
    const html = await renderViaHTTP(appPort, '/docs/github')
    expect(html).toMatch(/hi there/)
  })

  it('should allow params in query for rewrite', async () => {
    const html = await renderViaHTTP(appPort, '/query-rewrite/hello/world?a=b')
    const $ = cheerio.load(html)
    expect(JSON.parse($('#__NEXT_DATA__').html()).query).toEqual({
      first: 'hello',
      second: 'world',
      a: 'b',
      section: 'hello',
      name: 'world',
    })
  })

  it('should allow params in query for redirect', async () => {
    const res = await fetchViaHTTP(
      appPort,
      '/query-redirect/hello/world?a=b',
      undefined,
      {
        redirect: 'manual',
      }
    )
    const { pathname, query } = url.parse(res.headers.get('location'), true)
    expect(res.status).toBe(307)
    expect(pathname).toBe('/with-params')
    expect(query).toEqual({
      first: 'hello',
      second: 'world',
    })
  })

  it('should overwrite param values correctly', async () => {
    const html = await renderViaHTTP(appPort, '/test-overwrite/first/second')
    expect(html).toMatch(/this-should-be-the-value/)
    expect(html).not.toMatch(/first/)
    expect(html).toMatch(/second/)
  })

  // current routes order do not allow rewrites to override page
  // but allow redirects to
  it('should not allow rewrite to override page file', async () => {
    const html = await renderViaHTTP(appPort, '/nav')
    expect(html).toContain('to-hello')
  })

  it('show allow redirect to override the page', async () => {
    const res = await fetchViaHTTP(appPort, '/redirect-override', undefined, {
      redirect: 'manual',
    })
    const { pathname } = url.parse(res.headers.get('location') || '')
    expect(res.status).toBe(307)
    expect(pathname).toBe('/thank-you-next')
  })

  it('should work successfully on the client', async () => {
    const browser = await webdriver(appPort, '/nav')
    await browser.elementByCss('#to-hello').click()
    await browser.waitForElementByCss('#hello')

    expect(await browser.eval('window.location.href')).toMatch(/\/first$/)
    expect(await getBrowserBodyText(browser)).toMatch(/Hello/)

    await browser.eval('window.location.href = window.location.href')
    await waitFor(500)
    expect(await browser.eval('window.location.href')).toMatch(/\/first$/)
    expect(await getBrowserBodyText(browser)).toMatch(/Hello/)

    await browser.elementByCss('#to-nav').click()
    await browser.waitForElementByCss('#to-hello-again')
    await browser.elementByCss('#to-hello-again').click()
    await browser.waitForElementByCss('#hello-again')

    expect(await browser.eval('window.location.href')).toMatch(/\/second$/)
    expect(await getBrowserBodyText(browser)).toMatch(/Hello again/)

    await browser.eval('window.location.href = window.location.href')
    await waitFor(500)
    expect(await browser.eval('window.location.href')).toMatch(/\/second$/)
    expect(await getBrowserBodyText(browser)).toMatch(/Hello again/)
  })

  it('should match a page after a rewrite', async () => {
    const html = await renderViaHTTP(appPort, '/to-hello')
    expect(html).toContain('Hello')
  })

  it('should match dynamic route after rewrite', async () => {
    const html = await renderViaHTTP(appPort, '/blog/post-1')
    expect(html).toMatch(/post:.*?post-2/)
  })

  it('should match public file after rewrite', async () => {
    const data = await renderViaHTTP(appPort, '/blog/data.json')
    expect(JSON.parse(data)).toEqual({ hello: 'world' })
  })

  it('should match /_next file after rewrite', async () => {
    await renderViaHTTP(appPort, '/hello')
    const data = await renderViaHTTP(
      appPort,
      `/hidden/_next/static/${buildId}/pages/hello.js`
    )
    expect(data).toContain('Hello')
    expect(data).toContain('createElement')
  })

  it('should allow redirecting to external resource', async () => {
    const res = await fetchViaHTTP(appPort, '/to-external', undefined, {
      redirect: 'manual',
    })
    const location = res.headers.get('location')
    expect(res.status).toBe(307)
    expect(location).toBe('https://google.com/')
  })

  it('should apply headers for exact match', async () => {
    const res = await fetchViaHTTP(appPort, '/add-header')
    expect(res.headers.get('x-custom-header')).toBe('hello world')
    expect(res.headers.get('x-another-header')).toBe('hello again')
  })

  it('should apply headers for multi match', async () => {
    const res = await fetchViaHTTP(appPort, '/my-headers/first')
    expect(res.headers.get('x-first-header')).toBe('first')
    expect(res.headers.get('x-second-header')).toBe('second')
  })

  it('should support proxying to external resource', async () => {
    const res = await fetchViaHTTP(appPort, '/proxy-me/first')
    expect(res.status).toBe(200)
    expect([...externalServerHits]).toEqual(['/first?path=first'])
    expect(await res.text()).toContain('hi from external')
  })

  it('should support unnamed parameters correctly', async () => {
    const res = await fetchViaHTTP(appPort, '/unnamed/first/final', undefined, {
      redirect: 'manual',
    })
    const { pathname } = url.parse(res.headers.get('location') || '')
    expect(res.status).toBe(307)
    expect(pathname).toBe('/got-unnamed')
  })

  it('should support named like unnamed parameters correctly', async () => {
    const res = await fetchViaHTTP(
      appPort,
      '/named-like-unnamed/first',
      undefined,
      {
        redirect: 'manual',
      }
    )
    const { pathname } = url.parse(res.headers.get('location') || '')
    expect(res.status).toBe(307)
    expect(pathname).toBe('/first')
  })

  it('should add refresh header for 308 redirect', async () => {
    const res = await fetchViaHTTP(appPort, '/redirect4', undefined, {
      redirect: 'manual',
    })
    expect(res.status).toBe(308)
    expect(res.headers.get('refresh')).toBe(`0;url=/`)
  })

  it('should handle basic api rewrite successfully', async () => {
    const data = await renderViaHTTP(appPort, '/api-hello')
    expect(JSON.parse(data)).toEqual({ query: {} })
  })

  it('should handle api rewrite with un-named param successfully', async () => {
    const data = await renderViaHTTP(appPort, '/api-hello-regex/hello/world')
    expect(JSON.parse(data)).toEqual({
      query: { name: 'hello/world', first: 'hello/world' },
    })
  })

  it('should handle api rewrite with param successfully', async () => {
    const data = await renderViaHTTP(appPort, '/api-hello-param/hello')
    expect(JSON.parse(data)).toEqual({
      query: { name: 'hello', hello: 'hello' },
    })
  })

  it('should handle encoded value in the pathname correctly', async () => {
    const res = await fetchViaHTTP(
      appPort,
      '/redirect/me/to-about/' + encodeURI('\\google.com'),
      undefined,
      {
        redirect: 'manual',
      }
    )

    const { pathname, hostname, query } = url.parse(
      res.headers.get('location') || '',
      true
    )
    expect(res.status).toBe(307)
    expect(pathname).toBe(encodeURI('/\\google.com/about'))
    expect(hostname).not.toBe('google.com')
    expect(query).toEqual({})
  })

  it('should handle unnamed parameters with multi-match successfully', async () => {
    const html = await renderViaHTTP(
      appPort,
      '/unnamed-params/nested/first/second/hello/world'
    )
    const params = JSON.parse(
      cheerio
        .load(html)('p')
        .text()
    )
    expect(params).toEqual({ test: 'hello' })
  })

  it('should handle named regex parameters with multi-match successfully', async () => {
    const res = await fetchViaHTTP(
      appPort,
      '/docs/integrations/v2-some/thing',
      undefined,
      {
        redirect: 'manual',
      }
    )
    const { pathname } = url.parse(res.headers.get('location') || '')
    expect(res.status).toBe(307)
    expect(pathname).toBe('/integrations/-some/thing')
  })

  if (!isDev) {
    it('should output routes-manifest successfully', async () => {
      const manifest = await fs.readJSON(
        join(appDir, '.next/routes-manifest.json')
      )

      for (const route of [
        ...manifest.dynamicRoutes,
        ...manifest.rewrites,
        ...manifest.redirects,
        ...manifest.headers,
      ]) {
        route.regex = normalizeRegEx(route.regex)
      }

      expect(manifest).toEqual({
        version: 1,
        pages404: true,
        basePath: '',
        redirects: [
          {
            destination: '/:lang/about',
            regex: normalizeRegEx(
              '^\\/redirect\\/me\\/to-about(?:\\/([^\\/]+?))$'
            ),
            source: '/redirect/me/to-about/:lang',
            statusCode: 307,
          },
          {
            source: '/docs/router-status/:code',
            destination: '/docs/v2/network/status-codes#:code',
            statusCode: 301,
            regex: normalizeRegEx('^\\/docs\\/router-status(?:\\/([^\\/]+?))$'),
          },
          {
            source: '/docs/github',
            destination: '/docs/v2/advanced/now-for-github',
            statusCode: 301,
            regex: normalizeRegEx('^\\/docs\\/github$'),
          },
          {
            source: '/docs/v2/advanced/:all(.*)',
            destination: '/docs/v2/more/:all',
            statusCode: 301,
            regex: normalizeRegEx('^\\/docs\\/v2\\/advanced(?:\\/(.*))$'),
          },
          {
            source: '/hello/:id/another',
            destination: '/blog/:id',
            statusCode: 307,
            regex: normalizeRegEx('^\\/hello(?:\\/([^\\/]+?))\\/another$'),
          },
          {
            source: '/redirect1',
            destination: '/',
            statusCode: 307,
            regex: normalizeRegEx('^\\/redirect1$'),
          },
          {
            source: '/redirect2',
            destination: '/',
            statusCode: 301,
            regex: normalizeRegEx('^\\/redirect2$'),
          },
          {
            source: '/redirect3',
            destination: '/another',
            statusCode: 302,
            regex: normalizeRegEx('^\\/redirect3$'),
          },
          {
            source: '/redirect4',
            destination: '/',
            statusCode: 308,
            regex: normalizeRegEx('^\\/redirect4$'),
          },
          {
            source: '/redir-chain1',
            destination: '/redir-chain2',
            statusCode: 301,
            regex: normalizeRegEx('^\\/redir-chain1$'),
          },
          {
            source: '/redir-chain2',
            destination: '/redir-chain3',
            statusCode: 302,
            regex: normalizeRegEx('^\\/redir-chain2$'),
          },
          {
            source: '/redir-chain3',
            destination: '/',
            statusCode: 303,
            regex: normalizeRegEx('^\\/redir-chain3$'),
          },
          {
            destination: 'https://google.com',
            regex: normalizeRegEx('^\\/to-external$'),
            source: '/to-external',
            statusCode: 307,
          },
          {
            destination: '/with-params?first=:section&second=:name',
            regex: normalizeRegEx(
              '^\\/query-redirect(?:\\/([^\\/]+?))(?:\\/([^\\/]+?))$'
            ),
            source: '/query-redirect/:section/:name',
            statusCode: 307,
          },
          {
            destination: '/got-unnamed',
            regex: normalizeRegEx(
              '^\\/unnamed(?:\\/(first|second))(?:\\/(.*))$'
            ),
            source: '/unnamed/(first|second)/(.*)',
            statusCode: 307,
          },
          {
            destination: '/:0',
            regex: normalizeRegEx('^\\/named-like-unnamed(?:\\/([^\\/]+?))$'),
            source: '/named-like-unnamed/:0',
            statusCode: 307,
          },
          {
            destination: '/thank-you-next',
            regex: normalizeRegEx('^\\/redirect-override$'),
            source: '/redirect-override',
            statusCode: 307,
          },
          {
            destination: '/:first/:second',
            regex: normalizeRegEx(
              '^\\/docs(?:\\/(integrations|now-cli))\\/v2(.*)$'
            ),
            source: '/docs/:first(integrations|now-cli)/v2:second(.*)',
            statusCode: 307,
          },
          {
            destination: '/somewhere',
            regex: normalizeRegEx(
              '^\\/catchall-redirect(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))?$'
            ),
            source: '/catchall-redirect/:path*',
            statusCode: 307,
          },
        ],
        headers: [
          {
            headers: [
              {
                key: 'x-custom-header',
                value: 'hello world',
              },
              {
                key: 'x-another-header',
                value: 'hello again',
              },
            ],
            regex: normalizeRegEx('^\\/add-header$'),
            source: '/add-header',
          },
          {
            headers: [
              {
                key: 'x-first-header',
                value: 'first',
              },
              {
                key: 'x-second-header',
                value: 'second',
              },
            ],
            regex: normalizeRegEx('^\\/my-headers(?:\\/(.*))$'),
            source: '/my-headers/(.*)',
          },
          {
            headers: [
              {
                key: 'x-something',
                value: 'applied-everywhere',
              },
            ],
            regex: normalizeRegEx(
              '^(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))?$'
            ),
            source: '/:path*',
          },
        ],
        rewrites: [
          {
            destination: '/another/one',
            regex: normalizeRegEx('^\\/to-another$'),
            source: '/to-another',
          },
          {
            destination: '/404',
            regex: '^\\/nav$',
            source: '/nav',
          },
          {
            source: '/hello-world',
            destination: '/static/hello.txt',
            regex: normalizeRegEx('^\\/hello-world$'),
          },
          {
            source: '/',
            destination: '/another',
            regex: normalizeRegEx('^\\/$'),
          },
          {
            source: '/another',
            destination: '/multi-rewrites',
            regex: normalizeRegEx('^\\/another$'),
          },
          {
            source: '/first',
            destination: '/hello',
            regex: normalizeRegEx('^\\/first$'),
          },
          {
            source: '/second',
            destination: '/hello-again',
            regex: normalizeRegEx('^\\/second$'),
          },
          {
            destination: '/hello',
            regex: normalizeRegEx('^\\/to-hello$'),
            source: '/to-hello',
          },
          {
            destination: '/blog/post-2',
            regex: normalizeRegEx('^\\/blog\\/post-1$'),
            source: '/blog/post-1',
          },
          {
            source: '/test/:path',
            destination: '/:path',
            regex: normalizeRegEx('^\\/test(?:\\/([^\\/]+?))$'),
          },
          {
            source: '/test-overwrite/:something/:another',
            destination: '/params/this-should-be-the-value',
            regex: normalizeRegEx(
              '^\\/test-overwrite(?:\\/([^\\/]+?))(?:\\/([^\\/]+?))$'
            ),
          },
          {
            source: '/params/:something',
            destination: '/with-params',
            regex: normalizeRegEx('^\\/params(?:\\/([^\\/]+?))$'),
          },
          {
            destination: '/with-params?first=:section&second=:name',
            regex: normalizeRegEx(
              '^\\/query-rewrite(?:\\/([^\\/]+?))(?:\\/([^\\/]+?))$'
            ),
            source: '/query-rewrite/:section/:name',
          },
          {
            destination: '/_next/:path*',
            regex: normalizeRegEx(
              '^\\/hidden\\/_next(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))?$'
            ),
            source: '/hidden/_next/:path*',
          },
          {
            destination: `http://localhost:${externalServerPort}/:path*`,
            regex: normalizeRegEx(
              '^\\/proxy-me(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))?$'
            ),
            source: '/proxy-me/:path*',
          },
          {
            destination: '/api/hello',
            regex: normalizeRegEx('^\\/api-hello$'),
            source: '/api-hello',
          },
          {
            destination: '/api/hello?name=:first*',
            regex: normalizeRegEx('^\\/api-hello-regex(?:\\/(.*))$'),
            source: '/api-hello-regex/:first(.*)',
          },
          {
            destination: '/api/hello?hello=:name',
            regex: normalizeRegEx('^\\/api-hello-param(?:\\/([^\\/]+?))$'),
            source: '/api-hello-param/:name',
          },
          {
            destination: '/api/dynamic/:name?hello=:name',
            regex: normalizeRegEx('^\\/api-dynamic-param(?:\\/([^\\/]+?))$'),
            source: '/api-dynamic-param/:name',
          },
          {
            destination: '/with-params',
            regex: normalizeRegEx('^(?:\\/([^\\/]+?))\\/post-321$'),
            source: '/:path/post-321',
          },
          {
            destination: '/with-params',
            regex: normalizeRegEx(
              '^\\/unnamed-params\\/nested(?:\\/(.*))(?:\\/([^\\/]+?))(?:\\/(.*))$'
            ),
            source: '/unnamed-params/nested/(.*)/:test/(.*)',
          },
        ],
        dynamicRoutes: [
          {
            page: '/another/[id]',
            regex: normalizeRegEx('^\\/another\\/([^\\/]+?)(?:\\/)?$'),
          },
          {
            page: '/api/dynamic/[slug]',
            regex: normalizeRegEx('^\\/api\\/dynamic\\/([^\\/]+?)(?:\\/)?$'),
          },
          {
            page: '/blog/[post]',
            regex: normalizeRegEx('^\\/blog\\/([^\\/]+?)(?:\\/)?$'),
          },
        ],
      })
    })

    it('should have redirects/rewrites in build output', async () => {
      const manifest = await fs.readJSON(
        join(appDir, '.next/routes-manifest.json')
      )
      const cleanStdout = stripAnsi(stdout)
      expect(cleanStdout).toContain('Redirects')
      expect(cleanStdout).toContain('Rewrites')
      expect(cleanStdout).toContain('Headers')
      expect(cleanStdout).toMatch(/source.*?/i)
      expect(cleanStdout).toMatch(/destination.*?/i)

      for (const route of [...manifest.redirects, ...manifest.rewrites]) {
        expect(cleanStdout).toContain(route.source)
        expect(cleanStdout).toContain(route.destination)
      }

      for (const route of manifest.headers) {
        expect(cleanStdout).toContain(route.source)

        for (const header of route.headers) {
          expect(cleanStdout).toContain(header.key)
          expect(cleanStdout).toContain(header.value)
        }
      }
    })
  } else {
    it('should show error for dynamic auto export rewrite', async () => {
      const html = await renderViaHTTP(appPort, '/to-another')
      expect(html).toContain(
        `Rewrites don't support auto-exported dynamic pages yet`
      )
    })
  }
}

describe('Custom routes', () => {
  beforeEach(() => {
    externalServerHits = new Set()
  })
  beforeAll(async () => {
    externalServerPort = await findPort()
    externalServer = http.createServer((req, res) => {
      externalServerHits.add(req.url)
      res.end('hi from external')
    })
    await new Promise((resolve, reject) => {
      externalServer.listen(externalServerPort, error => {
        if (error) return reject(error)
        resolve()
      })
    })
    nextConfigRestoreContent = await fs.readFile(nextConfigPath, 'utf8')
    await fs.writeFile(
      nextConfigPath,
      nextConfigRestoreContent.replace(/__EXTERNAL_PORT__/, externalServerPort)
    )
  })
  afterAll(async () => {
    externalServer.close()
    await fs.writeFile(nextConfigPath, nextConfigRestoreContent)
  })

  describe('dev mode', () => {
    beforeAll(async () => {
      appPort = await findPort()
      app = await launchApp(appDir, appPort)
      buildId = 'development'
    })
    afterAll(() => killApp(app))
    runTests(true)
  })

  describe('server mode', () => {
    beforeAll(async () => {
      const { stdout: buildStdout } = await nextBuild(appDir, [], {
        stdout: true,
      })
      stdout = buildStdout
      appPort = await findPort()
      app = await nextStart(appDir, appPort)
      buildId = await fs.readFile(join(appDir, '.next/BUILD_ID'), 'utf8')
    })
    afterAll(() => killApp(app))
    runTests()
  })

  describe('serverless mode', () => {
    beforeAll(async () => {
      nextConfigContent = await fs.readFile(nextConfigPath, 'utf8')
      await fs.writeFile(
        nextConfigPath,
        nextConfigContent.replace(/\/\/ target/, 'target'),
        'utf8'
      )
      const { stdout: buildStdout } = await nextBuild(appDir, [], {
        stdout: true,
      })
      stdout = buildStdout
      appPort = await findPort()
      app = await nextStart(appDir, appPort, {
        onStdout: msg => {
          stdout += msg
        },
      })
      buildId = await fs.readFile(join(appDir, '.next/BUILD_ID'), 'utf8')
    })
    afterAll(async () => {
      await fs.writeFile(nextConfigPath, nextConfigContent, 'utf8')
      await killApp(app)
    })

    runTests()
  })

  describe('raw serverless mode', () => {
    beforeAll(async () => {
      nextConfigContent = await fs.readFile(nextConfigPath, 'utf8')
      await fs.writeFile(
        nextConfigPath,
        nextConfigContent.replace(/\/\/ target/, 'target'),
        'utf8'
      )
      await nextBuild(appDir)

      appPort = await findPort()
      app = await initNextServerScript(join(appDir, 'server.js'), /ready on/, {
        ...process.env,
        PORT: appPort,
      })
    })
    afterAll(async () => {
      await fs.writeFile(nextConfigPath, nextConfigContent, 'utf8')
      await killApp(app)
    })

    it('should apply rewrites in lambda correctly for page route', async () => {
      const html = await renderViaHTTP(appPort, '/query-rewrite/first/second')
      const data = JSON.parse(
        cheerio
          .load(html)('p')
          .text()
      )
      expect(data).toEqual({
        first: 'first',
        second: 'second',
        section: 'first',
        name: 'second',
      })
    })

    it('should apply rewrites in lambda correctly for dynamic route', async () => {
      const html = await renderViaHTTP(appPort, '/blog/post-1')
      expect(html).toContain('post-2')
    })

    it('should apply rewrites in lambda correctly for API route', async () => {
      const data = JSON.parse(
        await renderViaHTTP(appPort, '/api-hello-param/first')
      )
      expect(data).toEqual({
        query: {
          name: 'first',
          hello: 'first',
        },
      })
    })

    it('should apply rewrites in lambda correctly for dynamic API route', async () => {
      const data = JSON.parse(
        await renderViaHTTP(appPort, '/api-dynamic-param/first')
      )
      expect(data).toEqual({
        query: {
          slug: 'first',
          name: 'first',
          hello: 'first',
        },
      })
    })
  })
})
