import { Request, Response, Router } from 'express';
import { https } from 'follow-redirects';
import http from 'http';
import { Html5Entities } from 'html-entities';

import { asyncHandler, eqci, makePlainASCII_UC, notFoundForEverythingElse, processMillis, toInt } from './common';
import { Connection, pool } from './database';
import {
  altFormToStd,
  code2ToCode3,
  code3ToCode2,
  code3ToName,
  initGazetteer,
  longStates, nameToCode3,
  new3ToOld2,
  simplify, stateAbbreviations, usCounties, usTerritories
} from './gazetteer';
import { SearchResult } from './search-result';
import { AtlasLocation } from './atlas-location';
import { Hash } from './hash';

export const router = Router();

type RemoteMode = 'skip' | 'normal' | 'extend' | 'forced' | 'only';
type ParseMode = 'loose' | 'strict';

enum MatchType {EXACT_MATCH = 0, EXACT_MATCH_ALT, STARTS_WITH, SOUNDS_LIKE}

interface ParsedSearchString {
  targetCity: string;
  targetState: string;
  doZip: boolean;
  actualSearch: string;
  normalizedSearch: string;
}

class LocationHash extends Hash<string, AtlasLocation> {
}

interface GeoNamesMetrics {
 retrievalTime: number;
 rawCount: number;
 matchedCount: number;
}

interface GettyMetrics {
  totalTime: number;
  preliminaryTime: number;
  retrievalTime: number;
  matchedCount: number;
  retrievedCount: number;
  complete: boolean;
  failedSyntax: string;
}

interface RemoteSearchResults {
  geoNamesMatches: LocationHash;
  geoNamesMetrics: GeoNamesMetrics;
  geoNamesError: any;
  gettyMatches: LocationHash;
  gettyMetrics: GettyMetrics;
  gettyError: any;
  noErrors: boolean;
  matches: number;
}

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

const entities = new Html5Entities();

const zoneLookup: Record<string, string> = {};

const US_ZIP_PATTERN = /(\d{5})(-\d{4,6})?/;
const OTHER_POSTAL_CODE_PATTERN = /[0-9A-Z]{2,8}((-|\s+)[0-9A-Z]{2,6})?/i;
const TRAILING_STATE_PATTERN = /(.+)\b(\w{2,3})$/;

const NO_RESULTS_YET = -1;
const MAX_MONTHS_BEFORE_REDOING_EXTENDED_SEARCH = 12;
const DEFAULT_MATCH_LIMIT = 75;
const MAX_MATCH_LIMIT = 500;
const MIN_EXTERNAL_SOURCE = 100;
const SOURCE_GEONAMES_POSTAL_UPDATE = 101;
const SOURCE_GEONAMES_GENERAL_UPDATE = 103;
const ZIP_RANK = 9;

export async function initAtlas() {
  try {
    await initTimezones();
    await initFlagCodes();
    await initGazetteer();
  }
  catch (err) {
    console.error('atlas init error: ' + err);
  }
}

async function initTimezones() {
  const results: any[] = await pool.queryResults('SELECT location, zones FROM zone_lookup WHERE 1');

  results.forEach(result => {
    zoneLookup[result.location] = result.zones.split(',');
  });
}

const flagCodes = new Set<string>();

async function initFlagCodes() {
  return new Promise<any>((resolve, reject) => {
    https.get('https://skyviewcafe.com/assets/resources/flags/', res => {
      let allData = '';

      if (res.statusCode === 200) {
        res.on('data', (data: Buffer) => {
          allData += data.toString('utf8');
        });

        res.on('end', () => {
          const lines = allData.split(/\r\n|\n|\r/);

          lines.forEach(line => {
            const match = />(\w+)\.png</.exec(line);

            if (match)
              flagCodes.add(match[1]);
          });

          resolve();
        });
      }
      else
        reject('init flags error: ' + res.statusCode);
    }).on('error', err => reject(err));
  });
}

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const q = req.query.q ? req.query.q.trim() : 'Nashua, NH';
  const version = toInt(req.query.version, 9);
  const remoteMode = (/skip|normal|extend|forced|only/i.test(req.query.remote) ? req.query.remote.toLowerCase() : 'skip') as RemoteMode;
  const extend = (remoteMode === 'extend' || remoteMode === 'only');
  const limit = Math.min(toInt(req.query.limit, DEFAULT_MATCH_LIMIT), MAX_MATCH_LIMIT);

  const parsed = parseSearchString(q, version < 3 ? 'loose' : 'strict');
  const startTime = processMillis();

  const result = new SearchResult(q, parsed.normalizedSearch);
  let consultRemoteData = false;
  let dbMatchedOnlyBySound = false;
  let dbMatches = new LocationHash();

  for (let attempt = 0; attempt < 2 - 1; ++attempt) {
    const connection = await pool.getConnection();

    if (remoteMode === 'only' ||
        (remoteMode !== 'skip' && (remoteMode === 'forced' ||
        !(await hasSearchBeenDoneRecently(connection, parsed.normalizedSearch, extend)))))
    {
      consultRemoteData = true;
    }

    // if (startTime / 1000 > lastInit + REFRESH_TIME_FOR_INIT_DATA) {
    //   initTimeZones(connection);
    //   initFlagCodes();
    //   lastInit = Util.elapsedTimeSeconds();
    // }

    if (remoteMode === 'only')
      dbMatches.clear();
    else {
      dbMatches = await doDataBaseSearch(connection, parsed, extend, limit + 1);
      dbMatches.values.forEach(location => console.log(JSON.stringify(location)));
      dbMatchedOnlyBySound = true;

      dbMatches.values.every(location => {
        if (!location.matchedBySound)
          dbMatchedOnlyBySound = false;

        return !dbMatchedOnlyBySound;
      });
    }

    connection.release();

    if (consultRemoteData) {
      const foo: RemoteSearchResults = {} as RemoteSearchResults;
      const remoteSearch = await geoNamesSearchAux(parsed.targetCity, parsed.targetState, parsed.doZip, null, false);
      console.log(remoteSearch, foo);
    }
  }

  console.log(consultRemoteData);
  result.time = processMillis() - startTime;
  res.send(result);
}));

function parseSearchString(q: string, mode: ParseMode) {
  const parsed = {doZip: false, actualSearch: q} as ParsedSearchString;
  const parts = q.split(',');
  let targetCity = parts[0];
  let targetState = parts[1] ? parts[1].trim() : '';
  let targetCountry = parts[2] ? parts[2].trim() : '';
  let matcher: string[];

  // US ZIP codes
  if ((matcher = US_ZIP_PATTERN.exec(targetCity))) {
    targetCity = matcher[1];
    parsed.doZip = true;
  }
  // Other postal codes
  else if (/\d/.test(targetCity) && OTHER_POSTAL_CODE_PATTERN.exec(targetCity)) {
    targetCity = targetCity.toUpperCase();
    parsed.doZip = true;
  }
  else
    targetCity = makePlainASCII_UC(targetCity);

  targetState = makePlainASCII_UC(targetState);
  targetCountry = makePlainASCII_UC(targetCountry);

  if (targetCountry)
    targetState = targetCountry;

  if (mode === 'loose' && !targetState && (matcher = TRAILING_STATE_PATTERN.exec(targetCity))) {
    const start = matcher[1].trim();
    const end = matcher[2];

    if (longStates[end] || code3ToName[end]) {
      targetCity = start;
      targetState = end;
    }
  }

  parsed.targetCity = targetCity;
  parsed.targetState = targetState;
  parsed.normalizedSearch = targetCity;

  if (targetState)
    parsed.normalizedSearch += ', ' + targetState;

  return parsed;
}

function startsWithICND(testee: string, test: string): boolean { // Ignore Case aNd Diacriticals
  if (!testee || !test)
    return false;

  testee = simplify(testee);
  test   = simplify(test);

  return testee.startsWith(test);
}


function closeMatchForCity(target: string, candidate: string): boolean {
  if (!target || !candidate)
    return false;

  target    = simplify(target);
  candidate = simplify(candidate);

  return candidate.startsWith(target);
}

function closeMatchForState(target: string, state: string, country: string): boolean {
  if (!target)
    return true;

  const  longState   = longStates[state];
  const  longCountry = code3ToName[country];
  const  code2       = code3ToCode2[country];
  const  oldCode2    = new3ToOld2[country];

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

function countyStateCleanUp(s: string): string {
  s = s.replace(CLEANUP1, '');
  s = s.replace(CLEANUP2, '');
  s = s.replace(CLEANUP3, '').trim();

  return s;
}

function isRecognizedUSCounty(county: string, state: string): boolean {
  return usCounties.has(county + ', ' + state);
}

function standardizeShortCountyName(county: string): string {
  if (!county)
    return county;

  county = county.trim();
  county = county.replace(/ \(.*\)/g, '');
  county = county.replace(/\s+/g, '');
  county = county.replace(/\s*?-\s*?\b/g, '-');
  county = county.replace(/ (Borough|Census Area|County|Division|Municipality|Parish)/ig, '');
  county = county.replace(/Aleutian Islands/i, 'Aleutians West');
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

  const match = /^Mc([a-z])(.*)/.exec(county);

  if (match)
    county = 'Mc' + match[1].toUpperCase() + match[2];

  return county;
}


function matchingLocationFound(matches: LocationHash, location: AtlasLocation): boolean {
  return matches.values.findIndex(location2 =>
    location2.city === location.city &&
    location2.county === location.county &&
    location2.state === location.state &&
    location2.country === location.country) >= 0;
}

function fixRearrangedName(name: string): {name: string, variant: string} {
  let variant: string;
  let match: string[];

  if ((match = /(.+), (\w)(.*')/.exec(name))) {
    variant = match[1];
    name = match[2].toUpperCase() + match[3] + variant;
  }
  else if ((match = /(.+), (\w)(.*)/.exec(name))) {
    variant = match[1];
    name = match[2].toUpperCase() + match[3] + ' ' + variant;
  }

  return {name, variant};
}

function getCode3ForCountry(country: string): string {
  country = simplify(country).substr(0, 20);

  return nameToCode3[country];
}

const APARTMENTS_ETC = new RegExp('\\b((mobile|trailer|vehicle)\\s+(acre|city|community|corral|court|estate|garden|grove|harbor|haven|' +
                                  'home|inn|lodge|lot|manor|park|plaza|ranch|resort|terrace|town|villa|village)s?)|' +
                                  '((apartment|condominium|\\(subdivision\\))s?)\\b', 'i');
const IGNORED_PLACES = new RegExp('bloomingtonmn|census designated place|colonia \\(|colonia number|condominium|circonscription electorale d|' +
                                  'election precinct|\\(historical\\)|mobilehome|subdivision|unorganized territory|\\{|\\}', 'i');

function processPlaceNames(city: string, county: string, state: string, country: string, continent: string,
                           decodeHTML = false, notrace = true): ProcessedNames {
  let abbrevState: string;
  let code3: string;
  let longState: string;
  let longCountry: string;
  let altForm: string;
  let origCounty: string;
  let variant: string;

  if (decodeHTML) {
    city      = entities.decode(city);
    county    = entities.decode(county);
    state     = entities.decode(state);
    country   = entities.decode(country);
    continent = entities.decode(continent);
  }

  if (/\b\d+[a-z]/i.test(city))
    return null;

  if (APARTMENTS_ETC.test(city))
    return null;

  if (IGNORED_PLACES.test(city))
    return null;

  if (/\bParis \d\d\b/i.test(city))
    return null;

  ({name: city, variant} = fixRearrangedName(city));

//  if (/,/.test(city))
//    logWarning(MessageFormat.format("City name \"{0}\" ({1}, {2}) contains a comma.", city, state, country), notrace);

  let match: string[];

  if (!variant && (match = /^(lake|mount|(?:mt\.?)|the|la|las|el|le|los)\b(.+)/i.exec(city)))
    variant = match[2].trim();

  altForm = altFormToStd[simplify(country)];

  if (altForm)
    country = altForm;

  state  = countyStateCleanUp(state);
  county = countyStateCleanUp(county);

  longState   = state;
  longCountry = country;
  code3       = getCode3ForCountry(country);

  if (code3) {
    country = code3;
  }
  else if (code3ToName[country]) {
    longCountry = code3ToName[country];
  }
  else {
    // logWarning(MessageFormat.format("Failed to recognize country \"{0}\" for city \"{1}, {2}\".", country, city, state), notrace);
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
      {} // logWarning(MessageFormat.format("Failed to recognize state/province \"{0}\" in country {1}.", state, country), notrace);
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
        {} // logWarning(MessageFormat.format("Failed to recognize US county \"{0}\" for city \"{1}\".", county, city), notrace);
      }
    }
  }

  return {city, variant, county, state, longState, country, longCountry, continent};
}

function getFlagCode(country: string, state: string): string {
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

function makeLocationKey(city: string, state: string, country: string, otherLocations: LocationHash): string {
  let baseKey: string;
  let key: string;
  let index = 1;

  city = simplify(city, false);

  if (state && (country === 'USA' || country === 'CAN'))
    key = city + ',' + state;
  else
    key = city + ',' + country;

  baseKey = key;

  while (otherLocations.contains(key)) {
    ++index;
    key = baseKey + '(' + index + ')';
  }

  return key;
}

async function hasSearchBeenDoneRecently(connection: Connection, searchStr: string, extended: boolean): Promise<boolean> {
  return await logSearchResults(connection, searchStr, extended, NO_RESULTS_YET, false);
}

async function logSearchResults(connection: Connection, searchStr: string, extended: boolean, matchCount: number, dbUpdate: boolean): Promise<boolean> {
  let dbHits = 0;
  let ageMonths = -1;
  let found = false;
  let wasExtended = false;
  let matches = 0;

  const results = await connection.queryResults('SELECT extended, hits, matches, TIMESTAMPDIFF(MONTH, time_stamp, NOW()) as months FROM atlas_searches2 WHERE search_string = ?',
    [searchStr]);

  if (results && results.length > 0) {
    wasExtended = results[0].extended;
    dbHits      = results[0].hits;
    matches     = results[0].matches;
    ageMonths   = results[0].months;

    if (ageMonths < MAX_MONTHS_BEFORE_REDOING_EXTENDED_SEARCH && (wasExtended || !extended))
      found = true;
  }

  if (matchCount >= 0 && dbUpdate) {
    if (wasExtended)
      extended = true;

    if (matchCount < matches)
      matchCount = matches;

    let query: string;
    let values: any[];

    if (!found && ageMonths < 0) {
      query = 'INSERT INTO atlas_searches2 (search_string, extended, hits, matches) VALUES (?, ?, 1, ?)';
      values = [searchStr, extended, matchCount];
    }
    else {
      query = 'UPDATE atlas_searches2 SET hits = ?, extended = ? WHERE search_string = ?';
      values = [++dbHits, extended, searchStr];
    }

    await pool.queryResults(query, values);
  }

  return found;
}

async function doDataBaseSearch(connection: Connection, parsed: ParsedSearchString, extendedSearch: boolean, maxMatches: number): Promise<LocationHash> {
  const simplifiedCity = simplify(parsed.targetCity);
  const examined = new Set<number>();
  const matches = new LocationHash();

  for (let pass = 0; pass < 2; ++pass) {
    const condition = (pass === 0 ? ' AND rank > 0' : '');

    examined.clear();

    for (let matchType: number = MatchType.EXACT_MATCH; matchType <= MatchType.SOUNDS_LIKE; ++matchType) {
      let altName: string;
      let rankAdjust = 0;
      let query: string;
      let values: any[];

      switch (matchType) {
        case MatchType.EXACT_MATCH:
          if (parsed.doZip) {
            query = 'SELECT * FROM atlas2 WHERE postal_code = ?';
            values = [parsed.targetCity];
          }
          else {
            rankAdjust = 1;
            query = 'SELECT * FROM atlas2 WHERE key_name = ?' + condition;
            values = [simplifiedCity];
          }
        break;

        case MatchType.EXACT_MATCH_ALT:
          query = 'SELECT * FROM atlas_alt_names WHERE alt_key_name = ?';
          values = [simplifiedCity];

          const altResults = await pool.queryResults(query, values);
          let misspelling: string;
          let keyName: string;
          let itemNo = 0;

          if (altResults && altResults.length > 0) {
            misspelling = altResults[0].misspelling;
            keyName = altResults[0].atlas_key_name;
            altName = altResults[0].alt_name;
            itemNo = altResults[0].specific_item2;
          }
          else
            continue;

          if (misspelling === 'Y' || misspelling === 'y')
            altName = undefined;

          if (itemNo > 0)
            query = 'SELECT * FROM atlas2 WHERE item_no = ' + itemNo;
          else {
            query = 'SELECT * FROM atlas2 WHERE key_name = ?';
            values = [keyName];
          }
        break;

        case MatchType.STARTS_WITH:
          query = 'SELECT * FROM atlas2 WHERE ((key_name >= ? AND key_name < ?) ' +
                  'OR (variant >= ? AND variant < ?))' + condition;
          values = [simplifiedCity, simplifiedCity + '~', simplifiedCity, simplifiedCity + '~'];
        break;

        case MatchType.SOUNDS_LIKE:
          if (/\d/.test(parsed.targetCity))
            continue;

          rankAdjust = -1;
          query = 'SELECT * FROM atlas2 WHERE sound = SOUNDEX(?)' + condition;
          values = [simplifiedCity];
        break;
      }

      console.log(query, values);
      const results = await connection.queryResults(query, values);

      (results ? results : []).every((result: any) => {
        const itemNo = result.item_no;

        if (examined.has(itemNo))
          return true;

        examined.add(itemNo);

        let city = result.name;
        const county = result.admin2;
        const state = result.admin1;
        const country = result.country;
        const longCountry = code3ToName[country];
        const latitude: number = result.latitude;
        const longitude: number = result.longitude;
        const elevation: number = result.elevation;
        const zone = result.time_zone;
        const zip = result.postal_code;
        let rank: number = result.rank;
        const placeType = result.feature_type;
        const source: number = result.source;
        const geonameID: number = result.geonames_id;

        if (source >= MIN_EXTERNAL_SOURCE && !extendedSearch && pass === 0)
          return true;

        if (!closeMatchForState(parsed.targetState, state, country))
          return true;

        if (altName)
          city = altName;

        if (parsed.doZip)
          rank = ZIP_RANK;
        else {
          rank += rankAdjust;

          if (rank >= ZIP_RANK)
            rank = ZIP_RANK - 1;
          else if (rank < 0)
            rank = 0;
        }

        const location = new AtlasLocation();
        let key: string;

        location.city = city;
        location.county = countyStateCleanUp(county);
        location.state = countyStateCleanUp(state);
        location.country = country;
        location.longCountry = longCountry;
        location.flagCode = getFlagCode(country, state);
        location.latitude = latitude;
        location.longitude = longitude;
        location.elevation = elevation;
        location.zone = zone;
        location.zip = zip;
        location.rank = rank;
        location.placeType = placeType;
        location.source = source;
        location.geonameID = geonameID;

        if (matchType === MatchType.EXACT_MATCH_ALT)
          location.matchedByAlternateName = true;
        else if (matchType === MatchType.SOUNDS_LIKE)
          location.matchedBySound = true;

        key = makeLocationKey(city, state, country, matches);
        matches.put(key, location);

        return (matches.length <= maxMatches * 4);
      });

      // Skip SOUNDS_LIKE search step on first pass, or if better matches have already been found. Only one step needed for postal codes.
      if (((pass === 0 || matches.length > 0) && matchType >= MatchType.STARTS_WITH) || parsed.doZip)
        break;
    }

    if (parsed.doZip)
      break;
  }

  return matches;
}


async function geoNamesSearchAux(targetCity: string, targetState: string, doZip: boolean, metrics: GeoNamesMetrics, notrace: boolean): Promise<LocationHash> {
  const startTime = processMillis();
  const keyedPlaces = new LocationHash();

  targetCity = targetCity.replace(/^mt\b/i, 'mount');
  metrics = metrics ? metrics : {} as GeoNamesMetrics;

  let url = `http://api.geonames.org/${doZip ? 'postalCodeSearchJSON' : 'searchJSON'}?username=skyview&style=full`;

  if (doZip)
    url += '&postalcode=';
  else {
    url += '&isNameRequired=true'
            // Remove &featureCode=PRK for now -- too many obscure matches.
         + '&featureCode=LK&featureCode=MILB&featureCode=PPL&featureCode=PPLA&featureCode=PPLA2&featureCode=PPLA3'
         + '&featureCode=PPLA4&featureCode=PPLC&featureCode=PPLF&featureCode=PPLG&featureCode=PPLL&featureCode=PPLQ&featureCode=PPLR'
         + '&featureCode=PPLS&featureCode=PPLW&featureCode=PPLX&featureCode=ASTR&featureCode=ATHF&featureCode=CTRS&featureCode=OBS'
         + '&featureCode=STNB&featureCode=ATOL&featureCode=CAPE&featureCode=ISL&featureCode=MT&featureCode=PK'
         + '&q=';
  }

  url += encodeURIComponent(targetCity);

  // noinspection JSMismatchedCollectionQueryUpdate
  let geonames: any[];
  const options = {headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.14; rv:66.0) Gecko/20100101 Firefox/66.0'}};
  const results = await new Promise<any>((resolve, reject) => {
    http.get(url, options, res => {
      let lines = '';

      if (res.statusCode === 200) {
        res.on('data', (data: Buffer) => {
          lines += data.toString('utf8');
        });

        res.on('end', () => {
          try {
            resolve(JSON.parse(lines));
          }
          catch (err) {
            reject('GeoNames error: ' + err);
          }
        });
      }
      else
        reject('GeoNames error: ' + res.statusCode);
    }).on('error', err => reject(err));
  });

  if (results) {
    if (!doZip && results.totalResultsCount > 0 && Array.isArray(results.geonames))
      geonames = results.geonames;
    else if (doZip && Array.isArray(results.postalCodes))
      geonames = results.postalCodes;
  }

  if (geonames) {
    geonames.every(geoname => {
      const city: string = doZip ? geoname.placeName : geoname.name;
      let county: string = geoname.adminName2;
      let state: string;
      let country: string = geoname.countryCode;
      const continent: string = geoname.continentCode;
      const placeType = (doZip ? 'P.PPL' : geoname.fcl + '.' + geoname.fcode);

      if (continent === 'AN')
        country = 'ATA';

      if (country && code2ToCode3[country])
        country = code2ToCode3[country];

      if (country === 'USA') {
        county = standardizeShortCountyName(county);
        state = geoname.adminCode1;
      }
      else
        state = geoname.adminName1;

      const names = processPlaceNames(city, county, state, country, continent, false, notrace);

      if (!names)
        return true;

      if ((doZip || closeMatchForCity(targetCity, names.city) || closeMatchForCity(targetCity, names.variant)) &&
           closeMatchForState(targetState, state, country))
      {
        const location = new AtlasLocation();
        const population = toInt(geoname.population);
        let rank = 0;

        if (placeType.startsWith('A.') || placeType.startsWith('P.')) {
          ++rank;

          if (placeType.endsWith('PPLC'))
            ++rank;

          if (population > 0)
            rank += (population >= 1000000 ? 2 : 1);
        }

        location.city = names.city;
        location.county = names.county;
        location.state = names.state;
        location.country = names.country;
        location.longCountry = names.longCountry;
        location.flagCode = getFlagCode(names.country, names.state);
        location.rank = rank;
        location.placeType = placeType;
        location.latitude = geoname.lat;
        location.longitude = geoname.lng;
        location.zone = geoname.timezone && geoname.timezone.timeZoneId;
        location.zip = (doZip ? geoname.postalcode : undefined);
        location.variant = names.variant;
        location.source = (doZip ? SOURCE_GEONAMES_POSTAL_UPDATE : SOURCE_GEONAMES_GENERAL_UPDATE);
        location.geonameID = geoname.geonameId;

        if (!matchingLocationFound(keyedPlaces, location)) {
          keyedPlaces.put(makeLocationKey(location.city, location.state, location.country, keyedPlaces), location);
          ++metrics.matchedCount;
        }
      }

      return true;
    });
  }

  metrics.retrievalTime = processMillis() - startTime;

  return keyedPlaces;
}

notFoundForEverythingElse(router);
