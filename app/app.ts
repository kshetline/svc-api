import express, { Application, Request, Response } from 'express';
import serveIndex from 'serve-index';
import morgan from 'morgan';
import { join as pathJoin } from 'path';

import { router as atlasRouter, initAtlas } from './atlas';
import { router as stateRouter } from './states';
import { router as ipToLocationRouter } from './ip-to-location';
import { initTimeZoneLargeAlt } from 'ks-date-time-zone/dist/ks-timezone-large-alt';
import { svcApiConsole, svcApiLogStream, svcApiSkipFilter } from './svc-api-logger';

initTimeZoneLargeAlt();

const port = process.env.PORT;

const app: Application = express();

app.use(morgan('REQ: :method :url :status :res[content-length] - :response-time ms', {
  skip: svcApiSkipFilter,
  stream: svcApiLogStream
}));

app.use('/atlas/', atlasRouter);
app.use('/atlasdb/atlas/', atlasRouter); // Old Tomcat path
app.use('/states/', stateRouter);
app.use('/atlasdb/states/', stateRouter); // Old Tomcat path
app.use('/ip/', ipToLocationRouter);
app.use(express.static('../public'));
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
