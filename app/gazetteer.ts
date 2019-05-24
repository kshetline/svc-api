import { createReadStream, statSync } from 'fs';
import stream from 'stream';
import { promisify } from 'util';
import { makePlainASCII_UC } from './common';

const finished = promisify(stream.finished);

const altFormToStd: Record<string, string> = {};
const code3ToName: Record<string, string> = {};
const nameToCode3: Record<string, string> = {};
const code2ToCode3: Record<string, string> = {};
const code3ToCode2: Record<string, string> = {};
const new3ToOld2: Record<string, string> = {};

(async () => {
  try {
    const path = 'app/data/country_codes.txt';
    const length = statSync(path).size;
    const input = createReadStream('app/data/country_codes.txt', {encoding: 'utf8', highWaterMark: length});

    input.on('error', err => console.log('gazetteer init error: ' + err.toString().replace(/^error:\s+/i, '')));
    input.on('data', (data: Buffer) => {
      const lines = data.toString('utf8').split(/\r\n|\n|\r/);

      lines.forEach(line => {
        if (line.length >= 75) {
          const name = line.substr(0, 47).trim();
          const code2 = line.substr(48, 2).trim();
          const oldCode2 = line.substr(51, 2).trim();
          const code3 = line.substr(56, 3);
          const code3Flag = line.substr(59, 1).trim();

          if (line.length > 76) {
            const altForm = line.substring(76).trim();
            const altForms = altForm.split(';');

            altForms.forEach(alt => {
              alt = alt.substr(0, 20);
              altFormToStd[simplify(alt)] = name;
            });
          }

          nameToCode3[simplify(name).substr(0, 20)] = code3;

          if (!code3Flag)
            code3ToName[code3] = name;

          if (code2) {
            code2ToCode3[code2] = code3;
            code3ToCode2[code3] = code2;
          }

          if (oldCode2)
            new3ToOld2[code3] = oldCode2;
        }
      });
    });

    await finished(input);
  }
  catch (err) {
    console.log('gazetteer init error: ' + err);
  }
})();

const VARIANT_START = /^((CANON DE|CERRO|FORT|FT|ILE D|ILE DE|ILE DU|ILES|ILSA|LA|LAKE|LAS|LE|LOS|MOUNT|MT|POINT|PT|THE) )(.*)/;

function simplify(s: string, asVariant = false): string {
  if (!s)
    return s;

  const pos = s.indexOf('(');

  if (pos >= 0)
    s = s.substring(0, pos).trim();

  s = makePlainASCII_UC(s);

  let sb: string[] = [];

  for (let i = 0; i < s.length; ++i) {
    const ch = s.charAt(i);

    if (ch === '-' || ch === '.')
      sb.push(' ');
    else if (ch === ' ' || /[0-9A-Z]/i.test(ch))
      sb.push(ch);
  }

  s = sb.join('');

  if (asVariant) {
    const match = VARIANT_START.exec(s);

    if (match)
      s = match[3];
  }
  else if (s.startsWith('FORT '))
    s = 'FT' + s.substring(5);
  else if (s.startsWith('MOUNT '))
    s = 'MT' + s.substring(6);
  else if (s.startsWith('POINT '))
    s = 'PT' + s.substring(6);

  if (s.startsWith('SAINT '))
    s = 'ST' + s.substring(6);
  else if (s.startsWith('SAINTE '))
    s = 'STE' + s.substring(7);

  sb = [];

  for (let i = 0; i < s.length && sb.length < 40; ++i) {
    const ch = s.charAt(i);

    if (ch !== ' ')
      sb.push(ch);
  }

  return sb.join('');
}
