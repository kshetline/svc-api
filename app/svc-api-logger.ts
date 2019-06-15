import rfs from 'rotating-file-stream';
import { join as pathJoin } from 'path';
import stream, { Writable } from 'stream';
import { WriteStream } from 'fs';
import { Request, Response } from 'express';
import * as util from 'util';
import { formatDateTime } from 'ks-util';

export let svcApiLogStream: Writable | WriteStream = process.stdout;

if (process.env.SVC_API_LOG) {
  const logPath = pathJoin(__dirname, process.env.SVC_API_LOG);
  const fileStream = rfs(logPath, {
    size: '1M',
    interval: '7d',
    maxFiles: 10
  });

  svcApiLogStream = new stream.Writable();
  svcApiLogStream._write = (chunk: any, encoding: string, done: (error?: Error) => void) => {
    let output: any;

    if (chunk instanceof Buffer) {
      try {
        output = chunk.toString(encoding === 'buffer' ? 'utf8' : encoding);
      }
      catch (err) {
        // Unknown encoding?
        output = chunk.toString('utf8');
      }
    }
    else
      output = chunk.toString();

    try {
      fileStream.write(output);
    }
    catch (err) { /* ignore errors writing to log file */ }

    process.stdout.write(output);
    done();
  };
}

// Only log requests that are for SVC API calls, not for static files pulled from the "public" folder.
export function svcApiSkipFilter(req: Request, res: Response): boolean {
  return !/^\/?(atlas|atlasdb|ip|maps|states|timeservices|zoneloc)(\/|\?|$)/.test(req.baseUrl);
}

function argsToString(...args: any[]): string {
  let result = '';

  if (args.length > 0)
    result += ': ' + util.format(args[0], ...(args.splice(1)));

  return result + '\n';
}

export function getLogDate(): string {
  return formatDateTime(new Date()) + ' - ';
}

class SvcApiConsole {
  assert(assertion: boolean, ...args: any[]): void {
    if (!assertion) {
      this.error(...args);
      this.trace();
    }
  }

  // noinspection JSMethodCanBeStatic
  debug(...args: any) {
    svcApiLogStream.write(getLogDate() + 'DEBUG' + argsToString(...args));
  }

  // noinspection JSMethodCanBeStatic
  error(...args: any) {
    svcApiLogStream.write(getLogDate() + 'ERROR' + argsToString(...args));
  }

  // noinspection JSMethodCanBeStatic
  info(...args: any) {
    svcApiLogStream.write(getLogDate() + 'INFO' + argsToString(...args));
  }

  // noinspection JSMethodCanBeStatic
  log(...args: any) {
    svcApiLogStream.write(getLogDate() + 'LOG' + argsToString(...args));
  }

  // noinspection JSMethodCanBeStatic
  trace(): void {
    let stack = '';

    try {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error('');
    }
    catch (err) {
      stack = err.stack || '';
    }

    const lines = stack.split('\n');

    svcApiLogStream.write(getLogDate() + 'TRACE:\n' + lines.splice(2).join('\n'));
  }

  // noinspection JSMethodCanBeStatic
  warn(...args: any) {
    svcApiLogStream.write(getLogDate() + 'WARN' + argsToString(...args));
  }
}

export const svcApiConsole = new SvcApiConsole();

if (!(process.hrtime as any).bigint)
  svcApiConsole.warn('Environment does not support process.hrtime.bigint');
