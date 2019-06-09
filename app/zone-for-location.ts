import { Request, Response, Router } from 'express';
import { toBoolean, toNumber } from 'ks-util';
import mime from 'mime';
import { asyncHandler, getWebPage, processMillis } from './common';

export const router = Router();

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const lat = toNumber(req.query.lat);
  const lon = toNumber(req.query.lon);
  const time = toNumber(req.query.timestamp, Math.floor(processMillis() / 1000));
  const key = encodeURIComponent(process.env.GOOGLE_API_KEY);
  const plainText = toBoolean(req.query.pt, true);
  const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lon}&timestamp=${time}&key=${key}`;
  let data: any;

  try {
    data = JSON.parse(await getWebPage(url));
  }
  catch (err) {
    data = {status: 'ERROR', errorMessage: err.toString()};
  }

  if (plainText) {
    res.set('Content-Type', mime.getType('.txt'));
    res.send(JSON.stringify(data));
  }
  else if (req.query.callback)
    res.jsonp(data);
  else
    res.send(data);
}));