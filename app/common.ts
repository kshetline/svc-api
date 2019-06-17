import { NextFunction, Request, Response, Router } from 'express';
import { isNil } from 'lodash';
import http, { RequestOptions } from 'http';
import zlib from 'zlib';
import { https } from 'follow-redirects';
import { parse as parseUrl } from 'url';
import { createReadStream } from 'fs';
import iconv from 'iconv-lite';

export const MIN_EXTERNAL_SOURCE = 100;
export const SOURCE_GEONAMES_POSTAL_UPDATE  = 101;
export const SOURCE_GEONAMES_GENERAL_UPDATE = 103;
export const SOURCE_GETTY_UPDATE = 104;

export function notFound(res: Response): void {
  res.status(403).send('Not found');
}

export function processMillis(): number {
  if ((process.hrtime as any).bigint)
    return Number((process.hrtime as any).bigint()) / 1000000;
  else {
    const time = process.hrtime();

    return time[0] * 1000 + time[1] / 1000000;
  }
}

export function formatVariablePrecision(value: number, maxDecimals = 3) {
  let result = value.toFixed(maxDecimals);

  if (result.substr(-1) === '0')
    result = result.replace(/\.?0+$/, '');

  return result;
}

export function notFoundForEverythingElse(router: Router) {
  router.get('*', (req: Request, res: Response) => notFound(res));
}

export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => void) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function eqci (s1: string, s2: string): boolean {
  return s1 === s2 || isNil(s1) && isNil(s2) || s1.localeCompare(s2, undefined, {usage: 'search', sensitivity: 'base'}) === 0;
}

export class PromiseTimeoutError extends Error {
  constructor(message?: string) {
    super(message);
  }
}

export function timedPromise<T>(promise: Promise<T>, maxTime: number, errorResponse?: any): Promise<T> {
  if (typeof errorResponse === 'string')
    errorResponse = new PromiseTimeoutError(errorResponse);

  const timer = new Promise<T>((resolve, reject) => setTimeout(() => reject(errorResponse), maxTime));

  return Promise.race([promise, timer]);
}

export async function getWebPage(urlOrOptions: string | RequestOptions, encoding?: string): Promise<string>;
export async function getWebPage(url: string, options: RequestOptions, encoding?: string): Promise<string>;
export async function getWebPage(urlOrOptions: string | RequestOptions, optionsOrEncoding?: RequestOptions | string, encoding?: string): Promise<string> {
  let options: RequestOptions;

  if (typeof urlOrOptions === 'string')
    options = parseUrl(urlOrOptions);

  if (typeof optionsOrEncoding === 'string')
    encoding = optionsOrEncoding;
  else if (optionsOrEncoding) {
    if (options)
      Object.assign(options, optionsOrEncoding);
    else
      options = optionsOrEncoding;
  }
  else if (!options)
    options = urlOrOptions as RequestOptions;

  if (!options.headers)
    options.headers = {'accept-encoding': 'gzip, deflate, br'};
  else if (!options.headers['accept-encoding'])
    options.headers['accept-encoding'] = 'gzip, deflate, br';

  if (!encoding)
    encoding = 'utf8';

  const protocol = (options.protocol === 'https:' ? https : http);

  return new Promise<string>((resolve, reject) => {
    protocol.get(options, res => {
      let content = '';

      if (res.statusCode === 200) {
        let source = res as any;
        const contentEncoding = res.headers['content-encoding'];
        let charset = (res.headers['content-type'] || '').toLowerCase();
        let usingIconv = false;
        const $ = /\bcharset\s*=\s*['"]?\s*([\w\-]+)\b/.exec(charset);

        if ($)
          charset = $[1] === 'utf-8' ? 'utf8' : $[1];
        else
          charset = encoding;

        if (contentEncoding === 'gzip') {
          source = zlib.createGunzip();
          res.pipe(source);
        }
        else if (contentEncoding === 'deflate') {
          source = zlib.createInflate();
          res.pipe(source);
        }
        else if (contentEncoding === 'br') {
          source = zlib.createBrotliDecompress();
          res.pipe(source);
        }
        else if (contentEncoding && contentEncoding !== 'identity') {
          reject(415); // Unsupported Media Type
          return;
        }

        if (!/^(ascii|utf8|utf16le|ucs2|base64|binary|hex)$/.test(charset)) {
          if (!iconv.encodingExists(charset)) {
            reject(415); // Unsupported Media Type
            return;
          }

          const prevSource = source;
          source = iconv.decodeStream(charset);
          prevSource.pipe(source);
          usingIconv = true;
        }

        source.on('data', (data: Buffer) => {
          if (usingIconv)
            content += data.toString();
          else
            content += data.toString(charset);
        });

        source.on('end', () => {
          resolve(content);
        });
      }
      else
        reject(res.statusCode);
    }).on('error', err => reject(err));
  });
}

export async function getFileContents(path: string, encoding?: string): Promise<string> {
  if (!encoding)
    encoding = 'utf8';

  return new Promise<string>((resolve, reject) => {
    const input = createReadStream(path, {encoding: encoding});
    let content = '';

    input.on('error', err => {
      reject(`Error reading ${path}: ${err.toString()}`);
    });
    input.on('data', (data: Buffer) => {
      content += data.toString(encoding);
    });
    input.on('end', () => {
      input.close();
      resolve(content);
    });
  });
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getRemoteAddress(req: Request): string {
  return (req.headers['x-real-ip'] as string) || req.connection.remoteAddress;
}
