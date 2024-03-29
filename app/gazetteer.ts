import { readdirSync } from 'fs';
import { eqci, getFileContents } from './common';
import { AtlasLocation } from './atlas-location';
import { decode } from 'html-entities';
import { MapClass } from './map-class';
import { logWarning } from './atlas_database';
import { acos, cos_deg, PI, sin_deg } from '@tubular/math';
import { join as pathJoin } from 'path';
import { svcApiConsole } from './svc-api-logger';
import { makePlainASCII_UC } from '@tubular/util';
import { requestText } from 'by-request';

export interface ParsedSearchString {
  postalCode: string;
  targetCity: string;
  targetState: string;
  actualSearch: string;
  normalizedSearch: string;
}

export interface NameAndCode {
  name: string;
  code: string;
}

export type ParseMode = 'loose' | 'strict';

const US_ZIP_PATTERN = /(\d{5})(-\d{4,6})?/;
const OTHER_POSTAL_CODE_PATTERN = /[0-9A-Z]{2,8}((-|\s+)[0-9A-Z]{2,6})?/i;
const TRAILING_STATE_PATTERN = /(.+)\b(\w{2,3})$/;

interface ProcessedNames {
  city: string;
  variant: string;
  county: string;
  state: string;
  longState: string;
  country: string;
  longCountry: string;
  continent: string;
}

export class LocationMap extends MapClass<string, AtlasLocation> { }

export const longStates: Record<string, string> = {};
export const stateAbbreviations: Record<string, string> = {};
export const altFormToStd: Record<string, string> = {};
export const code3ToName: Record<string, string> = {};
export const nameToCode3: Record<string, string> = {};
export const code2ToCode3: Record<string, string> = {};
export const code3ToCode2: Record<string, string> = {};
export const new3ToOld2: Record<string, string> = {};

export const usCounties = new Set<string>();
export const celestialNames = new Set<string>();

export const states = [
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
  'Territory of Nunavut', 'NU',
  'Nunavut', 'NU', // Preferred form listed last
  'Ontario', 'ON',
  'Prince Edward Isle', 'PE',
  'Prince Edward Island', 'PE', // Preferred form listed last
  'Quebec', 'QC',
  'Saskatchewan', 'SK',
  'Yukon Territory', 'YT',
  'Yukon', 'YT'
];

const usStateCodes = 'AL AK AS AZ AR CA CO CT DE DC FM FL GA GU HI ID IL IN IA KS KY LA ME MH MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND MP OH OK OR PW PA PR RI SC SD TN TX UT VT VI VA WA WV WI WY';
export const usTerritories = 'AS  FM  GU   MH  MP PW   VI';
// const usTerritoryCountryCodes = 'ASM FSM GUM MHL MNP PLW VIR';

for (let i = 0; i < states.length; i += 2) {
  longStates[states[i + 1]] = states[i];
  stateAbbreviations[states[i]] = states[i + 1];
  stateAbbreviations[states[i].toUpperCase()] = states[i + 1];
}

export async function initGazetteer(): Promise<void> {
  try {
    await initFlagCodes();

    let lines = (await getFileContents('app/data/country_codes.txt', 'utf8')).split(/\r\n|\n|\r/);

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

    lines = (await getFileContents('app/data/us_counties.txt', 'utf8')).split(/\r\n|\n|\r/);
    lines.forEach(line => usCounties.add(line.trim()));
    // Add this fake county to suppress errors when DC is reported at the county level of a place hierarchy.
    usCounties.add('Washington, DC');

    lines = (await getFileContents('app/data/celestial.txt', 'utf8')).split(/\r\n|\n|\r/);
    lines.forEach(line => celestialNames.add(makePlainASCII_UC(line.trim())));
  }
  catch (err) {
    svcApiConsole.error('Gazetteer init error: ' + err);
  }
}

const flagCodes = new Set<string>();

async function initFlagCodes(): Promise<void> {
  try {
    const flagFiles = readdirSync(pathJoin(__dirname, '../../public/assets/resources/flags'));
    let $: string[];

    flagFiles.forEach(file => {
      if (($ = /^(\w+)\.png$/.exec(file)))
        flagCodes.add($[1]);
    });

    if (flagCodes.size) {
      svcApiConsole.info('Flag codes obtained from local directory');
      return;
    }
  }
  catch (err) { /* Ignore error, proceed to remote retrieval. */ }

  try {
    const lines = (await requestText('https://skyviewcafe.com/assets/resources/flags/')).split(/\r\n|\n|\r/);

    lines.forEach(line => {
      const $ = />(\w+)\.png</.exec(line);

      if ($)
        flagCodes.add($[1]);
    });

    svcApiConsole.info('Flag codes obtained from remote directory');
  }
  catch (err) {
    throw new Error('initFlagCodes error: ' + err);
  }
}

const VARIANT_START = /^((CANON DE|CERRO|FORT|FT|ILE D|ILE DE|ILE DU|ILES|ILSA|LA|LAKE|LAS|LE|LOS|MOUNT|MT|POINT|PT|THE) )(.*)/;

export function simplify(s: string, asVariant = false, processAbbreviations = true): string {
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

  if (processAbbreviations) {
    if (asVariant) {
      const $ = VARIANT_START.exec(s);

      if ($)
        s = $[3];
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
  }

  sb = [];

  for (let i = 0; i < s.length && sb.length < 40; ++i) {
    const ch = s.charAt(i);

    if (ch !== ' ')
      sb.push(ch);
  }

  return sb.join('');
}

function startsWithICND(testee: string, test: string): boolean { // Ignore Case aNd Diacriticals
  if (!testee || !test)
    return false;

  testee = simplify(testee);
  test = simplify(test);

  return testee.startsWith(test);
}

export function closeMatchForCity(target: string, candidate: string): boolean {
  if (!target || !candidate)
    return false;

  target = simplify(target);
  candidate = simplify(candidate);

  return candidate.startsWith(target);
}

export function closeMatchForState(target: string, state: string, country: string): boolean {
  if (!target)
    return true;

  const longState   = longStates[state];
  const longCountry = code3ToName[country];
  const code2       = code3ToCode2[country];
  const oldCode2    = new3ToOld2[country];

  return (startsWithICND(state, target) ||
          startsWithICND(country, target) ||
          startsWithICND(longState, target) ||
          startsWithICND(longCountry, target) ||
          (country === 'GBR' && startsWithICND('Great Britain', target)) ||
          (country === 'GBR' && startsWithICND('England', target)) ||
          startsWithICND(code2, target) ||
          startsWithICND(oldCode2, target));
}

const CLEANUP1 = /^((County(\s+of)?)|((Provincia|Prov\xC3\xADncia|Province|Regi\xC3\xB3n Metropolitana|Distrito|Regi\xC3\xB3n)\s+(de|del|de la|des|di)))/i;
const CLEANUP2 = /\s+(province|administrative region|national capital region|prefecture|oblast'|oblast|kray|county|district|department|governorate|metropolitan area|territory)$/;
const CLEANUP3 = /\s+(region|republic)$/;

export function countyStateCleanUp(s: string): string {
  s = s.replace(CLEANUP1, '');
  s = s.replace(CLEANUP2, '');
  s = s.replace(CLEANUP3, '').trim();

  return s;
}

export function isRecognizedUSCounty(county: string, state: string): boolean {
  return usCounties.has(county + ', ' + state);
}

export function standardizeShortCountyName(county: string): string {
  if (!county)
    return county;

  county = county.trim();
  county = county.replace(/ \(.*\)/g, '');
  county = county.replace(/\s+/g, ' ');
  county = county.replace(/\s*?-\s*?\b/g, '-');
  county = county.replace(/ (Borough|Census Area|County|Division|Municipality|Parish)/ig, '');
  county = county.replace(/Aleutian Islands/i, 'Aleutians West');
  county = county.replace(/Juneau City and/i, 'Juneau');
  county = county.replace(/Coös/i, 'Coos');
  county = county.replace(/De Kalb/i, 'DeKalb');
  county = county.replace(/De Soto/i, 'DeSoto');
  county = county.replace(/De Witt/i, 'DeWitt');
  county = county.replace(/Du Page/i, 'DuPage');
  county = county.replace(/^La(Crosse|Moure|Paz|Plate|Porte|Salle)/i, 'La $1');
  county = county.replace(/Skagway-Yakutat-Angoon/i, 'Skagway-Hoonah-Angoon');
  county = county.replace(/Grays Harbor/i, "Gray's Harbor");
  county = county.replace(/OBrien/i, "O'Brien");
  county = county.replace(/Prince Georges/i, "Prince George's");
  county = county.replace(/Queen Annes"/, "Queen Anne's");
  county = county.replace(/Scotts Bluff/i, "Scott's Bluff");
  county = county.replace(/^(St. |St )/i, 'Saint ');
  county = county.replace(/Saint Johns/i, "Saint John's");
  county = county.replace(/Saint Marys/i, "Saint Mary's");
  county = county.replace(/BronxCounty/i, 'Bronx');

  const $ = /^Mc([a-z])(.*)/.exec(county);

  if ($)
    county = 'Mc' + $[1].toUpperCase() + $[2];

  return county;
}

export function containsMatchingLocation(matches: LocationMap, location: AtlasLocation): boolean {
  return matches.values.findIndex(location2 =>
    location2.city === location.city &&
    location2.county === location.county &&
    location2.state === location.state &&
    location2.country === location.country) >= 0;
}

export function fixRearrangedName(name: string): { name: string, variant: string } {
  let variant: string;
  let $: string[];

  if (($ = /(.+), (\w)(.*')/.exec(name))) {
    variant = $[1];
    name = $[2].toUpperCase() + $[3] + variant;
  }
  else if (($ = /(.+), (\w)(.*)/.exec(name))) {
    variant = $[1];
    name = $[2].toUpperCase() + $[3] + ' ' + variant;
  }

  return { name, variant };
}

export function getCode3ForCountry(country: string): string {
  country = simplify(country).substr(0, 20);

  return nameToCode3[country];
}

const APARTMENTS_ETC = new RegExp('\\b((mobile|trailer|vehicle)\\s+(acre|city|community|corral|court|estate|garden|grove|harbor|haven|' +
                                  'home|inn|lodge|lot|manor|park|plaza|ranch|resort|terrace|town|villa|village)s?)|' +
                                  '((apartment|condominium|\\(subdivision\\))s?)\\b', 'i');
const IGNORED_PLACES = new RegExp('bloomingtonmn|census designated place|colonia \\(|colonia number|condominium|circonscription electorale d|' +
                                  'election precinct|\\(historical\\)|mobilehome|subdivision|unorganized territory|\\{|\\}', 'i');

export function processPlaceNames(city: string, county: string, state: string, country: string, continent: string,
                                  decodeHTML = false, noTrace = true): ProcessedNames {
  let abbrevState: string;
  let longState: string;
  let longCountry: string;
  let origCounty: string;
  let variant: string;

  if (decodeHTML) {
    city = decode(city);
    county = decode(county);
    state = decode(state);
    country = decode(country);
    continent = decode(continent);
  }

  if (/\b\d+[a-z]/i.test(city))
    return null;

  if (APARTMENTS_ETC.test(city))
    return null;

  if (IGNORED_PLACES.test(city))
    return null;

  if (/\bParis \d\d\b/i.test(city))
    return null;

  ({ name: city, variant } = fixRearrangedName(city));

  if (/,/.test(city))
    logWarning(`City name "${city}" (${state}, ${country}) contains a comma.`, noTrace);

  let $: string[];

  if (!variant && ($ = /^(lake|mount|(?:mt\.?)|the|la|las|el|le|los)\b(.+)/i.exec(city)))
    variant = $[2].trim();

  const altForm = altFormToStd[simplify(country)];

  if (altForm)
    country = altForm;

  state = countyStateCleanUp(state);
  county = countyStateCleanUp(county);

  longState = state;
  longCountry = country;
  const code3 = getCode3ForCountry(country);

  if (code3) {
    country = code3;
  }
  else if (code3ToName[country]) {
    longCountry = code3ToName[country];
  }
  else {
    logWarning(`Failed to recognize country "${country}" for city "${city}, ${state}".`, noTrace);
    country = country.replace(/^(.{0,2}).*$/, '$1?');
  }

  if (state.toLowerCase().endsWith(' state')) {
    state = state.substr(0, state.length - 6);
  }

  if (country === 'USA' || country === 'CAN') {
    if (state && longStates[state])
      longState = longStates[state];
    else if (state) {
      abbrevState = stateAbbreviations[makePlainASCII_UC(state)];

      if (abbrevState) {
        abbrevState = state;
        abbrevState = abbrevState.replace(/ (state|province)$/i, '');
        abbrevState = stateAbbreviations[makePlainASCII_UC(abbrevState)];
      }

      if (abbrevState)
        state = abbrevState;
      else
        logWarning(`Failed to recognize state/province "${state}" in country ${country}.`, noTrace);
    }

    if (county && country === 'USA' && usTerritories.indexOf(state) < 0) {
      origCounty = county;
      county = standardizeShortCountyName(county);

      if (!isRecognizedUSCounty(county, state)) {
        county = origCounty;

        if (county === 'District of Columbia')
          county = 'Washington';

        county = county.replace(/^City of /i, '');
        county = county.replace(/\s(Indep. City|Independent City|Independent|City|Division|Municipality)$/i, '');

        if (county !== origCounty) {
          if (simplify(origCounty) === simplify(city) || simplify(county) === simplify(city)) {
            // City is its own county in a sense -- and independent city. Blank out the redundancy.
            county = undefined;
          }
          // Otherwise, this is probably a neighborhood in an independent city. We'll treat
          // the independent city as a county, being that it's a higher administrative level,
          // adding "City of" where appropriate.
          else if (/city|division|municipality/i.test(city))
            county = 'City of ' + county;
        }
        else
          logWarning(`Failed to recognize US county "${county}" for city "${city}".`, noTrace);
      }
    }
  }

  return { city, variant, county, state, longState, country, longCountry, continent };
}

export function getFlagCode(country: string, state: string): string {
  let code;

  if (country === 'GBR' && eqci(state, 'England'))
    code = 'england';
  else if (country === 'GBR' && eqci(state, 'Scotland'))
    code = 'scotland';
  else if (country === 'GBR' && eqci(state, 'Wales'))
    code = 'wales';
  else if (country === 'ESP' && eqci(state, 'Catalonia'))
    code = 'catalonia';
  else
    code = code3ToCode2[country];

  if (code) {
    code = code.toLowerCase();

    if (!flagCodes.has(code))
      code = undefined;
  }
  else
    code = undefined;

  return code;
}

export function roughDistanceBetweenLocationsInKm(lat1: number, long1: number, lat2: number, long2: number): number {
  let deltaRad = acos(sin_deg(lat1) * sin_deg(lat2) + cos_deg(lat1) * cos_deg(lat2) * cos_deg(long1 - long2));

  while (deltaRad > PI)
    deltaRad -= PI;

  while (deltaRad < -PI)
    deltaRad += PI;

  return deltaRad * 6378.14; // deltaRad * radius_of_earth_in_km
}

export function makeLocationKey(city: string, state: string, country: string, otherLocations: LocationMap): string {
  let key: string;
  let index = 1;

  city = simplify(city, false);

  if (state && (country === 'USA' || country === 'CAN'))
    key = city + ',' + state;
  else
    key = city + ',' + country;

  const baseKey = key;

  while (otherLocations.has(key)) {
    ++index;
    key = baseKey + '(' + index + ')';
  }

  return key;
}

export function parseSearchString(q: string, mode: ParseMode): ParsedSearchString {
  const parsed = { actualSearch: q } as ParsedSearchString;
  const parts = q.split(',').map(part => part.trim());
  const altParts = q.split(/\s+/).map(part => part.trim()).filter(part => !/,/.test(part));
  let postalCode = '';
  let targetCity = parts[0];
  let targetState = parts[1];
  let targetCountry = parts[2];
  let $: string[];

  if (altParts.length > 1) {
    // US ZIP codes mixed with extra info
    if (($ = US_ZIP_PATTERN.exec(altParts[0]))) {
      postalCode = $[1];
      targetCity = '';
      targetState = altParts[1];
    }
    else if (($ = US_ZIP_PATTERN.exec(altParts[1]))) {
      postalCode = $[1];
      targetCity = altParts[0];
      targetState = '';
    }
    // Other postal codes mixed with extra info
    else if (/\d/.test(altParts[0]) && OTHER_POSTAL_CODE_PATTERN.exec(altParts[0])) {
      postalCode = altParts[0].toUpperCase();
      targetCity = '';
      targetState = altParts[1];
    }
    else if (/\d/.test(altParts[1]) && OTHER_POSTAL_CODE_PATTERN.exec(altParts[1])) {
      postalCode = altParts[1].toUpperCase();
      targetCity = altParts[0];
      targetState = '';
    }
  }

  if (!postalCode) {
    // US ZIP codes
    if (($ = US_ZIP_PATTERN.exec(targetCity))) {
      postalCode = $[1];
      targetCity = '';
    }
    // Other postal codes
    else if (/\d/.test(targetCity) && OTHER_POSTAL_CODE_PATTERN.exec(targetCity)) {
      postalCode = targetCity.toUpperCase();
      targetCity = '';
    }
    // Misplaced postal codes?
    else if (targetState && ($ = US_ZIP_PATTERN.exec(targetState))) {
      postalCode = $[1];
      targetState = '';
    }
    else if (targetState && /\d/.test(targetState) && OTHER_POSTAL_CODE_PATTERN.exec(targetState)) {
      postalCode = targetState.toUpperCase();
      targetState = '';
    }
    else
      targetCity = makePlainASCII_UC(targetCity);
  }

  targetState = makePlainASCII_UC(targetState);
  targetCountry = makePlainASCII_UC(targetCountry);

  if (targetCountry)
    targetState = targetCountry;

  if (mode === 'loose' && !targetState && ($ = TRAILING_STATE_PATTERN.exec(targetCity))) {
    const start = $[1].trim();
    const end = $[2];

    if (longStates[end] || code3ToName[end]) {
      targetCity = start;
      targetState = end;
    }
  }

  parsed.postalCode = postalCode;
  parsed.targetCity = targetCity;
  parsed.targetState = targetState;
  parsed.normalizedSearch = postalCode || targetCity;

  if (targetState)
    parsed.normalizedSearch += ', ' + targetState;
  else if (postalCode && targetCity)
    parsed.normalizedSearch = targetCity + ', ' + postalCode;

  return parsed;
}

const CENSUS_AREAS = new RegExp(
  '(Aleutians West|Bethel|Dillingham|Nome|Prince of Wales-Outer Ketchikan|' +
  'Skagway-Hoonah-Angoon|Southeast Fairbanks|Valdez-Cordova|Wade Hampton|' +
  'Wrangell-Petersburg|Yukon-Koyukuk)', 'i');

export function adjustUSCountyName(county: string, state: string): string {
  if (/ (Division|Census Area|Borough|Parish|County)$/i.test(county))
    return county;

  if (state === 'AK') {
    if (/Anchorage|Juneau/i.test(county)) {
      county += ' Division';
    }
    else if (CENSUS_AREAS.test(county))
      county += ' Census Area';
    else
      county += ' Borough';
  }
  else if (state === 'LA')
    county += ' Parish';
  else
    county += ' County';

  return county;
}

export function getStatesProvincesAndCountries(): NameAndCode[] {
  const usStates: NameAndCode[] = [];
  const canadianProvinces: NameAndCode[] = [];
  const countries: NameAndCode[] = [];
  const results: NameAndCode[] = [];

  Object.keys(longStates).forEach(code => {
    if (usStateCodes.indexOf(code) >= 0) {
      if (usTerritories.indexOf(code) < 0)
        usStates.push({ name: longStates[code], code });
    }
    else if (code.length === 2)
      canadianProvinces.push({ name: code === 'NF' ? 'Newfoundland' : longStates[code], code });
  });

  usStates.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  results.push(...usStates);

  canadianProvinces.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  results.push(null, ...canadianProvinces);

  Object.keys(code3ToName).forEach(code => {
    if (!/^(NML|XX.|(.*[^A-Z].*))$/.test(code))
      countries.push({ name: code3ToName[code], code });
  });

  countries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  results.push(null, ...countries);

  return results;
}
