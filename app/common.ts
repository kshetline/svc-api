import { NextFunction, Request, Response, Router } from 'express';

export function notFound(res: Response): void {
  res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
  res.write('Not found');
  res.end();
}

export function notFoundForEverythingElse(router: Router) {
  router.get('*', (req: Request, res: Response) => notFound(res));
}

export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => void) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function toBoolean(value: any, emptyStringIsTrue = false): boolean {
  if (typeof value === 'boolean')
    return value;
  else if (typeof value === 'string')
    return /true|yes|t|y|1/i.test(value) || (emptyStringIsTrue && value === '');
  else if (typeof value === 'number')
    return value !== 0;
  else
    return !!value;
}

export function toInt(value: any, defaultValue = 0): number {
  if (typeof value === 'number')
    return Math.floor(value);
  else if (typeof value === 'string') {
    const result = parseInt(value, 10);

    if (isNaN(result) || !isFinite(result))
      return defaultValue;
    else
      return result;
  }
  else if (typeof value === 'bigint') {
    const result = Number(value);

    if (isNaN(result) || !isFinite(result))
      return defaultValue;
    else
      return result;
  }
  else
    return defaultValue;
}
