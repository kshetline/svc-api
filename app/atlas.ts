import { Request, Response, Router } from 'express';
import { https } from 'follow-redirects';

import { asyncHandler, notFoundForEverythingElse, toInt } from './common';
import { pool } from './database';

export const router = Router();

type RemoteMode = 'skip' | 'normal' | 'extend' | 'forced' | 'only';
type ParseMode = 'loose' | 'strict';

(async () => {
  try {
    await initTimezones();
    await initFlagCodes();
  }
  catch (err) {
    console.log('atlas init error: ' + err);
  }
})();

const zoneLookup: {[key: string]: string[]} = {};

async function initTimezones() {
  const results: any[] = await pool.queryResults('SELECT location, zones FROM zone_lookup WHERE 1');

  results.forEach(result => {
    zoneLookup[result.location] = result.zones.split(',');
  });
}

const flagCodes = new Set<string>();

async function initFlagCodes() {
  return new Promise<any>((resolve, reject) => {
    https.get('https://skyviewcafe.com/assets/resources/flags/', res => {
      if (res.statusCode === 200) {
        res.on('data', (d: Buffer) => {
          const lines = d.toString('utf8').split(/\r\n|\n|\r/);

          lines.forEach(line => {
            const match = />(\w+)\.png</.exec(line);

            if (match)
              flagCodes.add(match[1]);
          });

          resolve();
        });
      }
      else
        reject('init flags error: ' + res.statusCode);
    }).on('error', err => reject(err));
  });
}

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  res.send('atlas: ' + JSON.stringify(req.query));

  const q = req.query.q ? req.query.q.trim() : 'Nashua, NH';
  const version = toInt(req.query.version, 9);
  const remoteMode = (/skip|normal|extend|forced|only/i.test(req.query.remote) ? req.query.remote.toLowerCase() : 'skip') as RemoteMode;
  const extend = (remoteMode === 'extend' || remoteMode === 'only');
  const parsed = parseSearchString(q, version < 3 ? 'loose' : 'strict');

  console.log(q, version, remoteMode, extend, parsed);
}));

function parseSearchString(q: string, mode: ParseMode) {
}

notFoundForEverythingElse(router);
