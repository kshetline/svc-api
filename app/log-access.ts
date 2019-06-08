import { Request, Response, Router } from 'express';
import auth from 'basic-auth';
import { createReadStream, existsSync, statSync } from 'fs';
import mime from 'mime';
import { join as pathJoin } from 'path';

export const router = Router();

router.get('/', (req: Request, res: Response) => {
  const user = auth(req);

  if (!user || !process.env.DB_PWD || user.name !== 'admin' || user.pass !== process.env.DB_PWD) {
    res.set('WWW-Authenticate', 'Basic realm="skyviewcafe.com"');
    res.status(401).send();
    return;
  }

  res.set('Content-Type', mime.getType('.txt'));

  if (process.env.SVC_API_LOG) {
    const path = pathJoin(__dirname, process.env.SVC_API_LOG);

    if (existsSync(path)) {
      const length = statSync(path).size;
      const input = createReadStream(path, {encoding: 'utf8', highWaterMark: length});

      input.on('error', err => res.send('Error reading log file.'));
      input.on('data', (data: Buffer) => {
        res.send(data.toString('utf8'));
      });
    }
    else
      res.send('Log file not present.');
  }
  else
    res.send('Log file not defined.');
});
