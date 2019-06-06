import express, { Application, Request, Response } from 'express';
import serveIndex from 'serve-index';
import morgan from 'morgan';
import { join as pathJoin } from 'path';

import { router as atlasRouter, initAtlas } from './atlas';
import { router as stateRouter } from './states';
import { router as ipToLocationRouter } from './ip-to-location';
import { initTimeZoneLargeAlt } from 'ks-date-time-zone/dist/ks-timezone-large-alt';
import {getLogDate, svcApiConsole, svcApiLogStream, svcApiSkipFilter} from './svc-api-logger';

initTimeZoneLargeAlt();

const app: Application = express();
const port = process.env.PORT || 80;

app.use(morgan((tokens, req, res) => {
  return [
    getLogDate().trim(),
    'REQ:',
    tokens.req(req, res, 'x-real-ip'), // Instead of `tokens['remote-addr'](req, res)` because we're running Node within Apache/nginx
    '"' + tokens.method(req, res),
    tokens.url(req, res),
    'HTTP/' + tokens['http-version'](req, res) + '"',
    tokens.status(req, res),
    tokens['response-time'](req, res), 'ms -',
    tokens.res(req, res, 'content-length')
  ].join(' ');
}, {
  skip: svcApiSkipFilter,
  stream: svcApiLogStream
}));

app.use('/atlas/', atlasRouter);
app.use('/atlasdb/atlas/', atlasRouter); // Legacy Tomcat path
app.use('/states/', stateRouter);
app.use('/atlasdb/states/', stateRouter); // Legacy Tomcat path
app.use('/ip/', ipToLocationRouter);
app.use(express.static('../public'));
// Make the flags folder browsable.
app.use('/assets/resources/flags/', serveIndex(pathJoin(__dirname, '../../public/assets/resources/flags/')));
app.get('/', (req: Request, res: Response) => {
  res.send('Static home file not found');
});

(async () => {
  try {
    await initAtlas();

    app.listen(port, () => {
      svcApiConsole.log(`Sky View Café listening on port ${port}.`);
    });
  }
  catch (err) {
    svcApiConsole.error('Sky View Café failed to start');
    process.exit(1);
  }
})();
