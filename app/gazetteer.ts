import { createReadStream, statSync } from 'fs';
import stream from 'stream';
import { promisify } from 'util';
import { makePlainASCII_UC } from './common';

const finished = promisify(stream.finished);

export const longStates: Record<string, string> = {};
export const stateAbbreviations: Record<string, string> = {};
export const altFormToStd: Record<string, string> = {};
export const code3ToName: Record<string, string> = {};
export const nameToCode3: Record<string, string> = {};
export const code2ToCode3: Record<string, string> = {};
export const code3ToCode2: Record<string, string> = {};
export const new3ToOld2: Record<string, string> = {};

export const usCounties = new Set<string>();
const celestialNames = new Set<string>();

const states = [
  'Alabama', 'AL',
  'Alaska', 'AK',
  'American Samoa', 'AS',
  'Arizona', 'AZ',
  'Arkansas', 'AR',
  'California', 'CA',
  'Colorado', 'CO',
  'Connecticut', 'CT',
  'Delaware', 'DE',
  'District of Columbia', 'DC',
  'Federated States of Micronesia', 'FM',
  'Florida', 'FL',
  'Georgia', 'GA',
  'Guam', 'GU',
  'Hawaii', 'HI',
  'Idaho', 'ID',
  'Illinois', 'IL',
  'Indiana', 'IN',
  'Iowa', 'IA',
  'Kansas', 'KS',
  'Kentucky', 'KY',
  'Louisiana', 'LA',
  'Maine', 'ME',
  'Marshall Islands', 'MH',
  'Maryland', 'MD',
  'Massachusetts', 'MA',
  'Michigan', 'MI',
  'Minnesota', 'MN',
  'Mississippi', 'MS',
  'Missouri', 'MO',
  'Montana', 'MT',
  'Nebraska', 'NE',
  'Nevada', 'NV',
  'New Hampshire', 'NH',
  'New Jersey', 'NJ',
  'New Mexico', 'NM',
  'New York', 'NY',
  'North Carolina', 'NC',
  'North Dakota', 'ND',
  'Northern Mariana Islands', 'MP',
  'Ohio', 'OH',
  'Oklahoma', 'OK',
  'Oregon', 'OR',
  'Palau', 'PW',
  'Pennsylvania', 'PA',
  'Puerto Rico', 'PR',
  'Rhode Island', 'RI',
  'South Carolina', 'SC',
  'South Dakota', 'SD',
  'Tennessee', 'TN',
  'Texas', 'TX',
  'Trust Territory of the Pacific Islands', '*TTPI',
  'Utah', 'UT',
  'Vermont', 'VT',
  'Virgin Islands', 'VI',
  'Virginia', 'VA',
  'Washington', 'WA',
  'West Virginia', 'WV',
  'Wisconsin', 'WI',
  'Wyoming', 'WY',

  'Alberta', 'AB',
  'British Columbia', 'BC',
  'Manitoba', 'MB',
  'New Brunswick', 'NB',
  'Newfoundland', 'NF',
  'Newfoundland and Labrador', 'NF',
  'Northwest Territories', 'NT',
  'Nova Scotia', 'NS',
  'Nunavut', 'NU',
  'Territory of Nunavut', 'NU',
  'Ontario', 'ON',
  'Prince Edward Island', 'PE',
  'Prince Edward Isle', 'PE',
  'Quebec', 'QC',
  'Saskatchewan', 'SK',
  'Yukon Territory', 'YT',
  'Yukon', 'YT'
];

// const usStates = 'AL AK AS AZ AR CA CO CT DE DC FM FL GA GU HI ID IL IN IA KS KY LA ME MH MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND MP OH OK OR PW PA PR RI SC SD TN TX UT VT VI VA WA WV WI WY';
export const usTerritories = 'AS  FM  GU   MH  MP PW   VI';
// const usTerritoryCountryCodes = 'ASM FSM GUM MHL MNP PLW VIR';

for (let i = 0; i < states.length; i += 2) {
  longStates[states[i + 1]] = states[i];
  stateAbbreviations[states[i]] = states[i + 1];
  stateAbbreviations[states[i].toUpperCase()] = states[i + 1];
}

export async function initGazetteer() {
  try {
    let path = 'app/data/country_codes.txt';
    let length = statSync(path).size;
    let input = createReadStream(path, {encoding: 'utf8', highWaterMark: length});

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
    input.close();

    path = 'app/data/us_counties.txt';
    length = statSync(path).size;
    input = createReadStream(path, {encoding: 'utf8', highWaterMark: length});

    input.on('error', err => console.log('gazetteer init error: ' + err.toString().replace(/^error:\s+/i, '')));
    input.on('data', (data: Buffer) => {
      const lines = data.toString('utf8').split(/\r\n|\n|\r/);

      lines.forEach(line => usCounties.add(line.trim()));
      // Add this fake county to suppress errors when DC is reported at the county level of a place hierarchy.
      usCounties.add('Washington, DC');
    });

    await finished(input);
    input.close();

    path = 'app/data/celestial.txt';
    length = statSync(path).size;
    input = createReadStream(path, {encoding: 'utf8', highWaterMark: length});

    input.on('error', err => console.log('gazetteer init error: ' + err.toString().replace(/^error:\s+/i, '')));
    input.on('data', (data: Buffer) => {
      const lines = data.toString('utf8').split(/\r\n|\n|\r/);

      lines.forEach(line => celestialNames.add(line.trim()));
    });

    await finished(input);
    input.close();
  }
  catch (err) {
    console.error('gazetteer init error: ' + err);
  }
}

const VARIANT_START = /^((CANON DE|CERRO|FORT|FT|ILE D|ILE DE|ILE DU|ILES|ILSA|LA|LAKE|LAS|LE|LOS|MOUNT|MT|POINT|PT|THE) )(.*)/;

export function simplify(s: string, asVariant = false): string {
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
