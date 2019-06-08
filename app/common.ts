import { NextFunction, Request, Response, Router } from 'express';
import { isNil } from 'lodash';
import http, { RequestOptions } from 'http';
import { https } from 'follow-redirects';
import { parse as parseUrl } from 'url';

export const MIN_EXTERNAL_SOURCE = 100;
export const SOURCE_GEONAMES_POSTAL_UPDATE  = 101;
export const SOURCE_GEONAMES_GENERAL_UPDATE = 103;
export const SOURCE_GETTY_UPDATE = 104;

export function notFound(res: Response): void {
  res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
  res.write('Not found');
  res.end();
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

  if (!encoding)
    encoding = 'utf8';

  const protocol = (options.protocol === 'https:' ? https : http);

  return new Promise<string>((resolve, reject) => {
    protocol.get(options, res => {
      let content = '';

      if (res.statusCode === 200) {
        res.on('data', (data: Buffer) => {
          content += data.toString(encoding);
        });

        res.on('end', () => {
          resolve(content);
        });
      }
      else
        reject(res.statusCode);
    }).on('error', err => reject(err));
  });
}
