import express, { Application, Request, Response } from 'express';
import morgan from 'morgan';

import { router as atlasRouter } from './atlas';
import { router as ipToLocationRouter } from './ip-to-location';

const port = process.env.PORT;

const app: Application = express();

app.use(morgan('tiny'));

app.get('/', (req: Request, res: Response) => {
  res.send('Hello World!');
});

app.use('/atlas/', atlasRouter);
app.use('/ip/', ipToLocationRouter);

app.listen(port, () => {
  console.log(`Sky View Café listening on port ${port}.`);
});
