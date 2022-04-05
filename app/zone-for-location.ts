import { Request, Response, Router } from 'express';
import { processMillis, toBoolean, toNumber } from '@tubular/util';
import { asyncHandler } from './common';
import { requestJson } from 'by-request';
import { pool } from './atlas_database';

export const router = Router();

export interface TzInfo {
  country?: string;
  dstOffset?: number;
  errorMessage?: string;
  fromDb?: boolean;
  rawOffset?: number;
  status?: string;
  timeZoneName?: string;
}

export async function getTimezoneForLocation(lat: number, lon: number, time = 0): Promise<TzInfo> {
  if (time === 0)
    time = Math.floor(processMillis() / 1000);

  try {
    const connection = await pool.getConnection();

    zoneLoop:
    for (const span of [0.05, 0.1, 0.25, 0.5]) {
      const query = 'SELECT time_zone, country FROM atlas2 WHERE latitude >= ? AND latitude <= ? AND longitude >= ? AND longitude <= ?';
      const results = (await connection.queryResults(query, [lat - span, lat + span, lon - span, lon + span])) || [];
      let timeZoneName: string;
      let country: string;

      for (const result of results) {
        if (result.time_zone) {
          if (!timeZoneName)
            timeZoneName = result.time_zone;
          else if (timeZoneName !== result.time_zone)
            break zoneLoop;

          if (!country)
            country = result.country;
          else if (country !== result.country)
            break zoneLoop;
        }
      }

      if (timeZoneName)
        return { timeZoneName, country, status: 'OK', fromDb: true };
    }
  }
  catch {}

  const key = encodeURIComponent(process.env.GOOGLE_API_KEY);
  const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lon}&timestamp=${time}&key=${key}`;
  let data: TzInfo;

  try {
    data = await requestJson(url);
  }
  catch (err) {
    data = { status: 'ERROR', errorMessage: err.toString() };
  }

  return data;
}

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const lat = toNumber(req.query.lat);
  const lon = toNumber(req.query.lon);
  const time = toNumber(req.query.timestamp);
  const plainText = toBoolean(req.query.pt, false, true);
  const data = await getTimezoneForLocation(lat, lon, time);

  if (plainText) {
    res.set('Content-Type', 'text/plain');
    res.send(JSON.stringify(data));
  }
  else if (req.query.callback)
    res.jsonp(data);
  else
    res.send(data);
}));
