import { Request, Response, Router } from 'express';
import https from 'https';
import { parse as parseUrl } from 'url';
import { notFoundForEverythingElse } from './common';

export const router = Router();

router.get('/', (req: Request, res: Response) => {
  const key = encodeURIComponent(process.env.GOOGLE_API_KEY);
  const url = `https://maps.googleapis.com/maps/api/js?key=${key}&callback=initGoogleMaps`;
  const options = parseUrl(url);

  console.log(JSON.stringify(options));
  const proxy = https.request(options, function (res2) {
    res.writeHead(res2.statusCode, res2.headers);
    res2.pipe(res, {
      end: true
    });
  });

  req.pipe(proxy, {
    end: true
  });
});

notFoundForEverythingElse(router);
