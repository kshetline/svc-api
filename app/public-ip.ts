import * as publicIp from 'public-ip';
import { processMillis } from './common';
import { svcApiConsole } from './svc-api-logger';

const REFRESH_TIME = 3600000; // One hour

let lastIp: string;
let lastIpTime = -REFRESH_TIME;

export async function getPublicIp(): Promise<string> {
  const now = processMillis();

  if (!lastIp || now >= lastIpTime + REFRESH_TIME) {
    const currentIp = await publicIp.v4();

    if (lastIp !== currentIp) {
      lastIp = currentIp;
      svcApiConsole.info('Public IP is ' + lastIp);
    }

    lastIpTime = now;
  }

  return lastIp;
}
