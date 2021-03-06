import puppeteer from "puppeteer-core/lib/cjs/puppeteer";
import {Browser} from "puppeteer-core/lib/cjs/puppeteer/common/Browser";
import {Page} from "puppeteer-core/lib/cjs/puppeteer/common/Page";
import {HTTPRequest} from "puppeteer-core/lib/cjs/puppeteer/common/HTTPRequest";
import {HTTPResponse} from "puppeteer-core/lib/cjs/puppeteer/common/HTTPResponse";
import {Target} from "puppeteer-core/lib/cjs/puppeteer/common/Target";
import {Viewport} from "puppeteer-core/lib/cjs/puppeteer/common/PuppeteerViewport";
import {Dialog} from 'puppeteer-core/lib/cjs/puppeteer/common/Dialog'
import {identity} from 'ramda';
import {concat, merge} from "rxjs";
import {delay, filter, tap, toArray} from "rxjs/operators";
import {LifecyclePort, sink, Socket, source, directProc, fromEventProc, latestMapProc, latestMergeMapProc, mapToProc, mergeMapProc, runKit, RunPort} from "pkit";

export * from './processors'

export type PuppeteerParams = Omit<PuppeteerBrowserParams & PuppeteerPageParams, 'browser'>;

export class PuppeteerPort extends LifecyclePort<PuppeteerParams> {
  run = new RunPort;
  browser = new PuppeteerBrowserPort;
  page = new PuppeteerPagePort;

  circuit (port: this) {
    return puppeteerKit(port)
  }
}

const puppeteerKit = (port: PuppeteerPort) =>
  merge(
    runKit(port.run, port.running),
    PuppeteerBrowserPort.prototype.circuit(port.browser),
    PuppeteerPagePort.prototype.circuit(port.page),
    directProc(source(port.init), sink(port.browser.init)),
    directProc(source(port.browser.ready), sink(port.ready)),
    latestMapProc(source(port.run.start), sink(port.page.init),
      [source(port.init), source(port.browser.browser)] as const, ([,page, browser]) =>
        ({browser, ...page, createNewPage: false})),
    directProc(source(port.page.ready), sink(port.run.started)),
    directProc(source(port.run.stop), sink(port.page.terminate)),
    directProc(source(port.page.terminated), sink(port.run.stopped)),
    mapToProc(source(port.run.stopped), sink(port.browser.terminate)),
    directProc(source(port.terminate), sink(port.browser.terminate)),
    directProc(source(port.browser.terminated), sink(port.terminated)),
  )

export type PuppeteerBrowserParams = {
  launch?: Readonly<Parameters<typeof puppeteer.launch>>
}

export class PuppeteerBrowserPort extends LifecyclePort<PuppeteerBrowserParams> {
  browser = new Socket<Browser>();
  event = new class {
    targetcreated = new Socket<Target>();
    disconnected = new Socket<void>();
  }

  circuit (port: this) {
    return puppeteerBrowserKit(port);
  }
}

const puppeteerBrowserKit = (port: PuppeteerBrowserPort) =>
  merge(
    mergeMapProc(source(port.init).pipe(
      filter(({launch}) =>
        !!launch)),
      sink(port.browser), ({launch}) =>
        puppeteer.launch(...launch!)),
    mapToProc(source(port.browser).pipe(delay(0)), sink(port.ready)),
    latestMergeMapProc(source(port.terminate), sink(port.info), [source(port.browser)],
      async ([,browser]) => ({close: await browser.close()})),
    fromEventProc(source(port.browser), sink(port.event.targetcreated), 'targetcreated'),
    fromEventProc(source(port.browser), sink(port.event.disconnected), 'disconnected'),
    mapToProc(source(port.event.disconnected), sink(port.terminated)),
  )

export type PuppeteerPageParams = {
  browser: Browser;
  userAgent?: string;
  viewport?: Viewport;
  goto?: Parameters<Page['goto']>;
  createNewPage?: boolean
}

export class PuppeteerPagePort extends LifecyclePort<PuppeteerPageParams> {
  page = new Socket<Page>();
  event = new class {
    load = new Socket<void>();
    close = new Socket<void>();
    response = new Socket<HTTPResponse>();
    request = new Socket<HTTPRequest>();
    dialog = new Socket<Dialog>();
  }

  circuit (port: this) {
    return puppeteerPageKit(port);
  }
}

const puppeteerPageKit = (port: PuppeteerPagePort) =>
  merge(
    mergeMapProc(source(port.init), sink(port.page),
      async ({browser, createNewPage = true}) =>
        createNewPage ?
          (await browser.newPage()) :
          (await browser.pages())[0]),

    latestMergeMapProc(source(port.page), sink(port.ready), [source(port.init)],
      ([page, {userAgent, viewport, goto}]) =>
        concat(...[
          Promise.resolve('ready'),
          userAgent && page.setUserAgent(userAgent),
          viewport && page.setViewport(viewport),
          goto && page.goto(...goto),
        ].filter(identity) as Promise<any>[]).pipe(
          toArray())),

    fromEventProc(source(port.page), sink(port.event.load), 'load'),
    fromEventProc(source(port.page), sink(port.event.close), 'close'),
    fromEventProc(source(port.page), sink(port.event.response), 'response'),
    fromEventProc(source(port.page), sink(port.event.request), 'request'),
    fromEventProc(source(port.page), sink(port.event.dialog), 'dialog'),

    // TODO: puppeteer-in-electron 使用時にヘッドありで開いた場合に page.close() で閉じずに実行結果が帰ってこない
    latestMergeMapProc(source(port.terminate), sink(port.info), [source(port.page)],
      async([,page]) => ({close: await page.close()})),

    mapToProc(source(port.event.close), sink(port.terminated))
  )