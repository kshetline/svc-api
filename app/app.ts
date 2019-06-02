import express, { Application, Request, Response } from 'express';
import serveIndex from 'serve-index';
import morgan from 'morgan';

import { router as atlasRouter, initAtlas } from './atlas';
import { router as ipToLocationRouter } from './ip-to-location';
import { initTimeZoneLargeAlt } from 'ks-date-time-zone/dist/ks-timezone-large-alt';

initTimeZoneLargeAlt();

const port = process.env.PORT;

const app: Application = express();

app.use(morgan('tiny'));

app.use('/atlas/', atlasRouter);
app.use('/ip/', ipToLocationRouter);
app.use(express.static('../public'));
app.use('/assets/resources/flags/', serveIndex('..public/assets/resources/flags/'));
app.get('/', (req: Request, res: Response) => {
  res.send('Static home file not found');
});

(async () => {
  try {
    await initAtlas();

    app.listen(port, () => {
      console.log(`Sky View Café listening on port ${port}.`);
    });
  }
  catch (err) {
    console.error('svc-api failed to start');
    process.exit(1);
  }
})();
