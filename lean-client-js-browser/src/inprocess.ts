// import * as BrowserFS from 'browserfs';
// avoid importing all BrowserFS backends per: https://github.com/jvilk/BrowserFS/issues/233#issuecomment-409523418
import ZipFS from 'browserfs/dist/node/backend/ZipFS';
import FS from 'browserfs/dist/node/core/FS';
import EmscriptenFS from 'browserfs/dist/node/generic/emscripten_fs';
import {Connection, Event, Transport, TransportError} from 'lean-client-js-core';

declare const Module: any;

export class InProcessTransport implements Transport {
    private loadJs: () => Promise<any>;
    private memoryMB: number;
    private libraryZip: Promise<Library>;
    private loadOlean: () => Promise<any>;
    private oleanMap: any;
    private info: any;

    constructor(loadJs: () => Promise<any>, libraryZip: Promise<Library>, memoryMB: number,
                loadOlean: () => Promise<any>) {
        this.loadJs = loadJs;
        this.libraryZip = libraryZip;
        this.memoryMB = memoryMB;
        this.loadOlean = loadOlean;
    }

    connect(): Connection {
        if ((self as any).Module) {
            throw new Error('cannot use more than one instance of InProcessTransport');
        }
        (self as any).Module = {};

        Module.noExitRuntime = true;
        Module.preRun = [ () => console.log('starting lean...') ];

        const conn = new InProcessConnection();

        Module.print = (text: string) => {
            try {
                const msg = JSON.parse(text);
                // replace 'source' fields using olean_map.json if possible
                if (this.oleanMap && this.info) {
                    // info response
                    if (msg.record && msg.record.source && msg.record.source.file) {
                        msg.record.source.file = this.getUrl(msg.record.source.file);
                    } else if (msg.results && !msg.file) { // search response
                        for (let i = 0; i < msg.results.length; i++) {
                            if (msg.results[i].source && msg.results[i].source.file) {
                                msg.results[i].source.file = this.getUrl(msg.results[i].source.file);
                            }
                        }
                    } else if (msg.completions) { // completion response
                        for (let i = 0; i < msg.completions.length; i++) {
                            if (msg.completions[i].source && msg.completions[i].source.file) {
                                msg.completions[i].source.file = this.getUrl(msg.completions[i].source.file);
                            }
                        }
                    }
                }
                conn.jsonMessage.fire(msg);
            } catch (e) {
                conn.error.fire({error: 'connect', message: `cannot parse: ${text}, error: ${e}`});
            }
        };
        Module.printErr = (text: string) => conn.error.fire({error: 'stderr', chunk: text});

        Module.TOTAL_MEMORY = this.memoryMB * 1024 * 1024;

        const emscriptenInitialized = new Promise((resolve, reject) => Module.onRuntimeInitialized = resolve);

        console.log('downloading lean...');
        conn.module = this.init(emscriptenInitialized);
        conn.module.catch((err) =>
            conn.error.fire({
                error: 'connect',
                message: `could not start emscripten version of lean: ${err}`,
            }));

        return conn;
    }

    private getUrl(sourceFile: string): string {
        const file = sourceFile.slice(9, -5); // remove '/library/' prefix and '.lean'
        const url = this.info[this.oleanMap[file]];
        return url ? url + file + '.lean' : sourceFile;
    }

    private async init(emscriptenInitialized: Promise<{}>): Promise<any> {
        const [loadJs, inited, library, oleanMap] = await Promise.all(
            [this.loadJs(), emscriptenInitialized, this.libraryZip, this.loadOlean()]);
        if (library) {
            const libraryFS = await new Promise<ZipFS>((resolve, reject) =>
                ZipFS.Create({zipData: library.zipBuffer},
                    (err, res) => err ? reject(err) : resolve(res)));
            const BrowserFS = new FS();
            BrowserFS.initialize(libraryFS);
            const BFS = new EmscriptenFS(Module.FS, Module.PATH, Module.ERRNO_CODES, BrowserFS);
            Module.FS.createFolder(Module.FS.root, 'library', true, true);
            Module.FS.mount(BFS, {root: '/'}, '/library');
            this.info = library.urls;
        }
        this.oleanMap = oleanMap;
        (Module.lean_init || Module._lean_init)();
        console.log('lean server initialized.');
        return Module;
    }
}

declare function lengthBytesUTF8(msg: string): number;
declare function stringToUTF8(msg: string, ptr: any, len: number);

class InProcessConnection implements Connection {
    error: Event<TransportError> = new Event();
    jsonMessage: Event<any> = new Event();
    alive: boolean = true;

    module: Promise<any>;

    send(jsonMsg: any) {
        this.module.then((mod) => {
            const msg = JSON.stringify(jsonMsg);
            const len = (lengthBytesUTF8 || mod.lengthBytesUTF8)(msg) + 1;
            const msgPtr = mod._malloc(len);
            (stringToUTF8 || mod.stringToUTF8)(msg, msgPtr, len);
            (mod.lean_process_request || mod._lean_process_request)(msgPtr);
            mod._free(msgPtr);
        });
    }

    dispose() {}
}

export interface LeanJsUrls {
    libraryZip?: string;

    javascript?: string;

    webassemblyWasm?: string;
    webassemblyJs?: string;
}

export interface LeanJsOpts extends LeanJsUrls {
    memoryMB?: number;
}

function waitForBody(): Promise<any> {
    return new Promise((resolve, reject) => {
        if (document.body) {
            resolve();
        } else {
            window.onload = resolve;
        }
    });
}

export function loadJsBrowser(url: string): Promise<any> {
    return waitForBody().then(() => new Promise<any>((resolve, reject) => {
        const script = document.createElement('script');
        script.onload = resolve;
        script.src = url;
        document.body.appendChild(script);
    }));
}

export function loadJsOrWasm(urls: LeanJsUrls, loadJs: (url: string) => Promise<any>): Promise<any> {
    if ((self as any).WebAssembly && urls.webassemblyJs && urls.webassemblyWasm) {
        // Module.wasmBinaryFile = urls.webassemblyWasm; // deprecated!
        Module.locateFile = () => urls.webassemblyWasm;
        return loadJs(urls.webassemblyJs);
    } else if (urls.javascript) {
        return loadJs(urls.javascript);
    } else {
        throw new Error(`cannot load lean.js from urls in ${urls}`);
    }
}

export interface Library {
    zipBuffer: Buffer;
    urls?: {};
}
function loadInfoJson(infoUrl: string): Promise<string> {
    // if this fails let's continue (we just won't be able to resolve lean files to github)
    return new Promise<string>((resolve, reject) => {
        const req = new XMLHttpRequest();
        req.responseType = 'text';
        req.open('GET', infoUrl);
        req.onloadend = (e) => {
            if (req.status === 200) {
                resolve(req.responseText);
            } else {
                console.log(`could not fetch ${infoUrl}: http code ${req.status} ${req.statusText}`);
                resolve(null);
            }
        };
        req.onerror = (e) => {
            console.log(`error fetching ${infoUrl}: ${e}`);
            resolve(null);
        };
        req.send();
    });
}

export function loadBufferFromURL(url: string, needUrls?: boolean): Promise<Library> {
    return new Promise<Library>((resolve, reject) => {
        const req = new XMLHttpRequest();
        req.responseType = 'arraybuffer';
        req.open('GET', url);
        req.onloadend = (e) => {
            if (req.status === 200) {
                if (needUrls) {
                    loadInfoJson(url.slice(0, -3) + 'info.json').then((urlstring) =>
                        resolve({zipBuffer: new Buffer(req.response as ArrayBuffer), urls: JSON.parse(urlstring)}));
                } else {
                    resolve({zipBuffer: new Buffer(req.response as ArrayBuffer)});
                }
            } else {
                reject(`could not fetch ${url}: http code ${req.status} ${req.statusText}`);
            }
        };
        req.onerror = (e) => reject(e);
        req.send();
    });
}

export function loadBufferFromURLCached(url: string): Promise<Library> {
    if (!url) {
        return null;
    }
    if (!url.toLowerCase().endsWith('.zip')) {
        return null;
    }
    if (!('indexedDB' in self)) {
        return loadBufferFromURL(url, true);
    }
    const filename = url.split('/').pop().split('.')[0];
    const infoPromise = loadInfoJson(url.slice(0, -3) + 'info.json');

    const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const ver = 3;
        const dbRequest = indexedDB.open('leanlibrary', ver);
        dbRequest.onsuccess = (event) => {
            // console.log('opened indexedDB');
            resolve(dbRequest.result);
        };
        dbRequest.onerror = (event) => {
            console.log('failed to open indexedDB');
            reject(dbRequest.error);
        };
        dbRequest.onupgradeneeded = (event) => {
            const {result: db} = dbRequest;
            const arr = dbRequest.result.objectStoreNames;
            for (let j = 0; j < arr.length; j++) {
                db.deleteObjectStore(arr[j]);
            }
            // console.log('creating indexedDB');
            db.createObjectStore('library');
            db.createObjectStore('meta');
        };
    });

    const metaPromise = dbPromise.then((db) => new Promise<string>((resolve, reject) => {
        const trans = db.transaction('meta').objectStore('meta').get(filename);
        trans.onsuccess = (event) => {
            // console.log('retrieved info.json from cache', trans.result);
            resolve(trans.result);
        };
        trans.onerror = (event) => {
            console.log(`error getting info.json for ${filename} from cache`);
            reject(trans.error);
        };
    }));

    return Promise.all([infoPromise, dbPromise, metaPromise])
        .then(([response, db, meta]) => {
            // TODO: better comparison between info.json and its cached version
            if (!meta || (meta !== response)) {
                // cache miss
                // console.log('cache miss!');
                const buffPromise = loadBufferFromURL(url);
                // assume that the file hasn't changed since head request...
                const metaUpdatePromise = new Promise<any>((res, rej) => {
                    // console.log('saving info.json to cache');
                    const trans = db.transaction('meta', 'readwrite').objectStore('meta')
                        .put(response, filename);
                    trans.onsuccess = (event) => {
                        // console.log('saved info.json to cache');
                        res(trans.result);
                    };
                    trans.onerror = (event) => {
                        console.log(`error saving info.json for ${filename} to cache`, event);
                        rej(trans.error);
                    };
                });
                return Promise.all([buffPromise, metaUpdatePromise])
                    .then(([buff, metaUpdate]) => {
                        return new Promise<Library>((res, rej) => {
                            // save buffer to cache
                            // console.log('saving library to cache');
                            const trans = db.transaction('library', 'readwrite').objectStore('library')
                                .put(buff.zipBuffer, filename);
                            trans.onsuccess = (event) => {
                                // console.log('saved library to cache');
                                res({zipBuffer: buff.zipBuffer, urls: JSON.parse(response)});
                            };
                            trans.onerror = (event) => {
                                console.log(`error saving ${filename} to cache`, event);
                                rej(trans.error);
                            };
                        });
                    });
            }
            // cache hit: pretend that the meta and library stores are always in sync
            return new Promise<Library>((res, rej) => {
                // console.log('cache hit!');
                const trans = db.transaction('library').objectStore('library')
                    .get(filename);
                trans.onsuccess = (event) => {
                    // console.log('retrieved library from cache', trans.result);
                    res({zipBuffer: new Buffer(trans.result), urls: JSON.parse(response)});
                };
                trans.onerror = (event) => {
                    console.log(`error getting ${filename} from cache`, event);
                    rej(trans.error);
                };
            });
        },
        (reason) => {
            console.log(`error in caching: ${reason}, falling back to uncached download`);
            return loadBufferFromURL(url, true);
        });
}

export class BrowserInProcessTransport extends InProcessTransport {
    constructor(opts: LeanJsOpts) {
        const loadOleanMap = (url) => fetch(url).then((res) => res.ok && res.json());

        super(() => loadJsOrWasm(opts, loadJsBrowser), loadBufferFromURLCached(opts.libraryZip), opts.memoryMB || 256,
        () => loadOleanMap(opts.libraryZip.slice(0, -3) + 'olean_map.json'));
    }
}
