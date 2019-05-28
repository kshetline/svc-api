import { Request, Response, Router } from 'express';
import { Html5Entities } from 'html-entities';

import {
  asyncHandler, eqci, getWebPage, makePlainASCII_UC, notFoundForEverythingElse, processMillis, timedPromise, toInt, toNumber
} from './common';
import { Connection, pool } from './database';
import { altFormToStd, code2ToCode3, code3ToCode2, code3ToName, initGazetteer, longStates, nameToCode3, new3ToOld2,
  simplify, stateAbbreviations, usCounties, usTerritories
} from './gazetteer';
import { SearchResult } from './search-result';
import { AtlasLocation } from './atlas-location';
import { MapClass } from './map-class';

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

class LocationMap extends MapClass<string, AtlasLocation> {}

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
  geoNamesMatches: LocationMap;
  geoNamesMetrics: GeoNamesMetrics;
  geoNamesError: any;
  gettyMatches: LocationMap;
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

const zoneLookup: Record<string, string[]> = {};

const US_ZIP_PATTERN = /(\d{5})(-\d{4,6})?/;
const OTHER_POSTAL_CODE_PATTERN = /[0-9A-Z]{2,8}((-|\s+)[0-9A-Z]{2,6})?/i;
const TRAILING_STATE_PATTERN = /(.+)\b(\w{2,3})$/;

const NO_RESULTS_YET = -1;
const MAX_MONTHS_BEFORE_REDOING_EXTENDED_SEARCH = 12;
const DEFAULT_MATCH_LIMIT = 75;
const MAX_MATCH_LIMIT = 500;

const MIN_EXTERNAL_SOURCE            = 100;
const SOURCE_GEONAMES_POSTAL_UPDATE  = 101;
const SOURCE_GEONAMES_GENERAL_UPDATE = 103;
const SOURCE_GETTY_UPDATE            = 104;

const ZIP_RANK = 9;

const MAX_TIME_GETTY                 = 110; // seconds
const PREFERRED_RETRIEVAL_TIME_GETTY =  40; // seconds
const MAX_TIME_GEONAMES              =  20; // seconds

const FAKE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.14; rv:66.0) Gecko/20100101 Firefox/66.0';

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
  try {
    const lines = (await getWebPage('https://skyviewcafe.com/assets/resources/flags/')).split(/\r\n|\n|\r/);

    lines.forEach(line => {
      const match = />(\w+)\.png</.exec(line);

      if (match)
        flagCodes.add(match[1]);
    });
  }
  catch (err) {
    throw new Error('initFlagCodes error: ' + err);
  }
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
  let remoteSearchResults;
  let dbMatchedOnlyBySound = false;
  let dbMatches = new LocationMap();

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
      dbMatchedOnlyBySound = true;

      dbMatches.values.every(location => {
        if (!location.matchedBySound)
          dbMatchedOnlyBySound = false;

        return !dbMatchedOnlyBySound;
      });
    }

    connection.release();

    if (consultRemoteData) {
      remoteSearchResults = await remoteSourcesSearch(parsed, extend, false);

      console.log(remoteSearchResults);
    }
  }

  result.time = processMillis() - startTime;
  res.send(remoteSearchResults);
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

  const match = /^Mc([a-z])(.*)/.exec(county);

  if (match)
    county = 'Mc' + match[1].toUpperCase() + match[2];

  return county;
}

function matchingLocationFound(matches: LocationMap, location: AtlasLocation): boolean {
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

  if (/,/.test(city))
    logWarning(`City name "${city}" (${state}, ${country}) contains a comma.`, notrace);

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
    logWarning(`Failed to recognize country "${country}" for city "${city}, ${state}".`, notrace);
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
        logWarning(`Failed to recognize state/province "${state}" in country ${country}.`, notrace);
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
          logWarning(`Failed to recognize US county "${county}" for city "${city}".`, notrace);
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

function getTimeZone(location: AtlasLocation): string {
  const county  = location.county;
  const state   = location.state;
  const country = location.country;
  let key = simplify(country);
  let zones = zoneLookup[key];
  let zones2: string[];
  let zone;

  if ((!zones || zones.length > 1) && state) {
    key += ':' + simplify(state);
    zones2 = zoneLookup[key];
    zones = (zones2 ? zones2 : zones);

    if ((!zones || zones.length > 1) && county) {
      key += ':' + simplify(county);
      zones2 = zoneLookup[key];
      zones = (zones2 ? zones2 : zones);
    }
  }

  if (!zones || zones.length === 0)
    zone = undefined;
  else {
    zone = zones[0];

    if (zones.length > 1)
      zone += '?';
  }

  return zone;
}

function makeLocationKey(city: string, state: string, country: string, otherLocations: LocationMap): string {
  let baseKey: string;
  let key: string;
  let index = 1;

  city = simplify(city, false);

  if (state && (country === 'USA' || country === 'CAN'))
    key = city + ',' + state;
  else
    key = city + ',' + country;

  baseKey = key;

  while (otherLocations.has(key)) {
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

async function doDataBaseSearch(connection: Connection, parsed: ParsedSearchString, extendedSearch: boolean, maxMatches: number): Promise<LocationMap> {
  const simplifiedCity = simplify(parsed.targetCity);
  const examined = new Set<number>();
  const matches = new LocationMap();

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
        matches.set(key, location);

        return (matches.size <= maxMatches * 4);
      });

      // Skip SOUNDS_LIKE search step on first pass, or if better matches have already been found. Only one step needed for postal codes.
      if (((pass === 0 || matches.size > 0) && matchType >= MatchType.STARTS_WITH) || parsed.doZip)
        break;
    }

    if (parsed.doZip)
      break;
  }

  return matches;
}

async function remoteSourcesSearch(parsed: ParsedSearchString, extend: boolean, notrace: boolean): Promise<RemoteSearchResults> {
  const results = {} as RemoteSearchResults;

  results.geoNamesMetrics = {} as GeoNamesMetrics;
  results.gettyMetrics = {} as GettyMetrics;

  const promises: Promise<LocationMap>[] = [];

  promises.push(geoNamesSearch(parsed.targetCity, parsed.targetState, parsed.doZip, results.geoNamesMetrics, notrace));

  if (extend && !parsed.doZip)
    promises.push(gettySearch(parsed.targetCity, parsed.targetState, results.gettyMetrics, notrace));

  const locationsOrErrors = await Promise.all(promises.map(promise => promise.catch(err => err)));

  if (locationsOrErrors[0] instanceof Error)
    results.geoNamesError = (locationsOrErrors[0] as Error).message;
  else
    results.geoNamesMatches = locationsOrErrors[0];

  if (locationsOrErrors[1] instanceof Error)
    results.gettyError = (locationsOrErrors[1] as Error).message;
  else
    results.gettyMatches = locationsOrErrors[1];

  results.noErrors = !!(results.geoNamesMatches && results.gettyMatches);
  results.matches = (results.geoNamesMatches ? results.geoNamesMatches.size : 0) + (results.gettyMatches ? results.gettyMatches.size : 0);

  return results;
}

async function gettySearch(targetCity: string, targetState: string, metrics: GettyMetrics, notrace: boolean): Promise<LocationMap> {
  return timedPromise(gettySearchAux(targetCity, targetState, metrics, notrace), MAX_TIME_GETTY * 1000, 'Getty search timed out');
}

async function gettySearchAux(targetCity: string, targetState: string, metrics: GettyMetrics, notrace: boolean): Promise<LocationMap> {
  const startTime = processMillis();
  const keyedPlaces = await gettyPreliminarySearch(targetCity, targetState, metrics, notrace);
  const originalKeys = keyedPlaces.keys;
  const itemCount = keyedPlaces.size;
  const matches = new LocationMap();
  const retrievalStartTime = processMillis();
  let goodFormat: boolean;
  let latitude = 0.0;
  let location: AtlasLocation;
  let longitude = 0.0;
  let retrieved = 0;
  let hasCoordinates = 0;
  let match: string[];

  for (let i = 0; i < originalKeys.length; ++i) {
    let key = originalKeys[i];
    const url = 'http://www.getty.edu/vow/TGNFullDisplay?find=&place=&nation=&english=Y&subjectid=' + key;
    const options = {headers: {'User-Agent': FAKE_USER_AGENT, 'Referer': 'http://www.getty.edu/vow/TGNServlet'}};
    let lines: string[];

    try {
      lines = (await getWebPage(url, options)).split(/\r\n|\n|\r/);
    }
    catch (err) {
      throw new Error('Getty secondary error: ' + err);
    }

    let pending = false;
    let gotLat = false;
    let gotLong = false;

    goodFormat = false;

    lines.every(line => {
      if ((match = /<B>ID: (\d+)<\/B>/.exec(line)) && key === match[1]) {
        pending = true;
        goodFormat = true;
        ++retrieved;
      }
      else if (pending && (match = /Lat:\s*([-.0-9]+).*decimal degrees</.exec(line))) {
        latitude = toNumber(match[1]);
        gotLat = true;
      }
      else if (pending && (match = /Long:\s*([-.0-9]+).*decimal degrees</.exec(line))) {
        longitude = toNumber(match[1]);
        gotLong = true;
      }

      if (gotLat && gotLong) {
        location = keyedPlaces.get(key);

        location.latitude = latitude;
        location.longitude = longitude;

        key = makeLocationKey(location.city, location.state, location.country, matches);
        matches.set(key, location);
        ++hasCoordinates;

        return false;
      }

      return true;
    });

    if (!goodFormat)
      throw new Error('Failed to parse secondary Getty data.');

    const totalTimeSoFar = processMillis() - retrievalStartTime;
    const remainingTime = PREFERRED_RETRIEVAL_TIME_GETTY * 1000 - totalTimeSoFar;

    // If this is taking too long, settle for what has already been retrieved and give up on the rest.
    if (remainingTime <= 0)
      break;
  }

  if (metrics) {
    const missingCoordinates = retrieved - hasCoordinates;

    metrics.matchedCount = itemCount - missingCoordinates;
    metrics.retrievedCount = retrieved - missingCoordinates;
    metrics.totalTime = processMillis() - startTime;
    metrics.preliminaryTime = retrievalStartTime - startTime;
    metrics.retrievalTime = metrics.totalTime - metrics.preliminaryTime;
    metrics.complete = (metrics.matchedCount === metrics.retrievedCount);
  }

  return matches;
}

enum Stage { LOOKING_FOR_ID_CODE, LOOKING_FOR_PLACE_NAME, LOOKING_FOR_HIERARCHY, LOOKING_FOR_EXTRAS_OR_END, PLACE_HAS_BEEN_PARSED }

async function gettyPreliminarySearch(targetCity: string, targetState: string, metrics: GettyMetrics, notrace: boolean): Promise<LocationMap> {
  let keyedPlaces = new LocationMap();
  const altKeyedPlaces = new LocationMap();
  let matchCount = 0;
  let nextItem = 1;
  let page = 0;
  let theresMore = false;
  let goodFormat: boolean;

  do {
    ++page;
    goodFormat = false;

    let altNames: string;
    let asAlternate: boolean;
    let city: string;
    let continent: string;
    let country: string;
    let county: string;
    let hierarchy: string;
    let key: string;
    let longCountry: string;
    let longState: string;
    let isMatch: boolean;
    let placeType: string;
    let stage: Stage;
    let state: string;
    let url: string;
    let variant: string;
    let vernacular: string;
    let searchStr = targetCity.toLowerCase().replace(' ', '-') + '*';
    let match: string[];

    searchStr = searchStr.replace(/^mt\b/, 'mount');

    url  = 'http://www.getty.edu/'
         + 'vow/TGNServlet'
         + '?nation='
         + '&english=Y'
         + '&find=' + encodeURIComponent(searchStr).replace('*', '%2A')
         + '&place=atoll%2C+cape%2C+city%2C+county%2C+dependent+state%2C+inhabited+place%2C+island%2C+mountain%2C+'
         +  'nation%2C+neighborhood%2C+park%2C+peak%2C+province%2C+state%2C+suburb%2C+town%2C+township%2C+village';

    if (page > 1)
      url += '&prev_page=' + (page - 1);

    url += '&page=' + page;

    const options = {headers: {'User-Agent': FAKE_USER_AGENT, 'Referer': 'http://www.getty.edu/research/tools/vocabularies/tgn/index.html'}};
    let lines: string[];

    try {
      lines = (await getWebPage(url, options)).split(/\r\n|\n|\r/);
    }
    catch (err) {
      throw new Error('Getty preliminary error: ' + err);
    }

    for (let i = 0; i < lines.length; ++i) {
      let line = lines[i];

      if (matchCount === 0 && /Your search has produced (no|too many) results\./i.test(line)) {
        goodFormat = true;

        break;
      }
      else if (matchCount === 0 && /Your search has invalid syntax\./i.test(line)) {
        goodFormat = true; // The Getty output format is good -- it's our input format that's bad.

        if (metrics != null)
          metrics.failedSyntax = searchStr;

        break;
      }
      else if (matchCount === 0 && /Server Error/i.test(line)) {
        throw new Error('Getty server error');
      }
      else if (/global_next.gif/i.test(line)) {
        theresMore = true;
      }
      else if ((match = /<TD><SPAN class="page"><B>(\d+)\.&nbsp;&nbsp;<\/B><\/SPAN><\/TD>/.exec(line)) &&
               toInt(match[1]) === nextItem) {
        ++nextItem;

        stage = Stage.LOOKING_FOR_ID_CODE;
        city = undefined;
        key = '0';
        hierarchy = undefined;
        altNames = '';
        asAlternate = false;
        vernacular = undefined;

        while (++i < lines.length) {
          line = lines[i].trim();

          if (stage === Stage.LOOKING_FOR_ID_CODE && (match = /<INPUT type=checkbox value=(\d+) name=checked>/.exec(line))) {
            key = match[1];
            stage = Stage.LOOKING_FOR_PLACE_NAME;
          }
          else if (stage === Stage.LOOKING_FOR_PLACE_NAME && (match = /(.+)<b>(.+)<\/B><\/A> \.\.\.\.\.\.\.\.\.\. \((.+)\)/.exec(line))) {
            city = match[2];
            placeType = match[3];
            stage = Stage.LOOKING_FOR_HIERARCHY;
          }
          else if (stage === Stage.LOOKING_FOR_HIERARCHY && (match = /<TD COLSPAN=2><SPAN CLASS=page>\((.+)\) \[\d+\]/.exec(line))) {
            hierarchy = match[1];
            // It sucks having commas as part of real data which is itself delimited by commas! (Foobar, Republic of).
            hierarchy = hierarchy.replace(/(, )(.[^,]+?), ([^,]+? (ar-|da|de|du|d'|La|la|Le|le|Las|las|Les|les|Los|los|of|The|the|van))(,|$)/g, '$1$3 2$5');

            if (/Indonesia/.test(hierarchy))
              hierarchy = hierarchy.replace(/(, Daerah Tingkat I)|(, Pulau)/, '');

            stage = Stage.LOOKING_FOR_EXTRAS_OR_END;
          }
          else if (stage === Stage.LOOKING_FOR_EXTRAS_OR_END) {
            if (!vernacular && (match = /Vernacular: (.+?)(<|$)/.exec(line))) {
              vernacular = match[1].trim();
            }
            else if ((match = /<B>(.+)<\/B><BR>/.exec(line))) {
              if (altNames)
                altNames += ';';

              altNames += match[1];
            }
            else if ((match = /<TD><SPAN class="page"><B>(\d+)\.&nbsp;&nbsp;<\/B><\/SPAN><\/TD>/.exec(line)) &&
                     toInt(match[1]) === nextItem) {
              --i; // We'll want to parse this same line again as the first line of the next city.
              stage = Stage.PLACE_HAS_BEEN_PARSED;
              break;
            }
            else if (/<\/TABLE>/.test(line)) {
              stage = Stage.PLACE_HAS_BEEN_PARSED;
              break;
            }
          }
        }

        if (stage === Stage.PLACE_HAS_BEEN_PARSED) {
          goodFormat = true;
          isMatch = false;
          continent = undefined;
          state = undefined;
          county = undefined;

          if ((match = /(.+?), (.+?), (.+?), (.+?), (.+?)(,|$)/.exec(hierarchy))) {
            continent = match[2];
            country = match[3];
            state = match[4];
            county = match[5];
          }
          else if ((match = /(.+?), (.+?), (.+?), (.+?)(,|$)/.exec(hierarchy))) {
            continent = match[2];
            country = match[3];
            state = match[4];
          }
          else if ((match = /(.+?), (.+?), (.+?)(,|$)/.exec(hierarchy))) {
            continent = match[2];
            country = match[3];
          }
          else if ((match = /(.+?), (.+?)(,|$)/.exec(hierarchy))) {
            continent = match[2];

            if (/Antarctica/i.test(hierarchy))
              country = 'ATA';
            else {
              const possibleCountry = fixRearrangedName(city).name;

              if (getCode3ForCountry(possibleCountry)) {
                city = possibleCountry;
                country = possibleCountry;
              }
              else
                country = undefined;
            }
          }
          else
            country = city;

          const names = processPlaceNames(city, county, state, country, continent, true, notrace);

          if (!names)
            continue;

          city = names.city;
          variant = names.variant;
          county = names.county;
          state = names.state;
          longState = names.longState;
          country = names.country;
          longCountry = names.longCountry;

          if (placeType === 'nation' || placeType === 'dependent state') {
            city = longCountry;

            if (closeMatchForCity(targetCity, country) || closeMatchForCity(targetCity, longCountry))
              isMatch = true;
          }
          else if (placeType === 'state' || placeType === 'province') {
            city = longState;

            if (closeMatchForCity(targetCity, state) || closeMatchForCity(targetCity, longState))
              isMatch = true;
          }
          else {
            if (closeMatchForCity(targetCity, city) || closeMatchForCity(targetCity, variant))
              isMatch = true;
            else if (closeMatchForCity(targetCity, vernacular)) {
              city = vernacular;
              isMatch = true;
            }
            else if (altNames) {
              altNames.split(';').every(altName => {
                if (closeMatchForCity(targetCity, altName)) {
                  city = altName;
                  isMatch = true;
                  asAlternate = true;

                  return false;
                }

                return true;
              });
            }
          }

          if (isMatch && closeMatchForState(targetState, state, country)) {
            if (placeType === 'cape')
              placeType = 'T.CAPE';
            else if (placeType === 'park')
              placeType = 'L.PRK';
            else if (placeType === 'peak')
              placeType = 'T.PK';
            else if (placeType === 'county')
              placeType = 'A.ADM2';
            else if (placeType === 'atoll' || placeType === 'island')
              placeType = 'T.ISL';
            else if (placeType === 'mountain')
              placeType = 'T.MT';
            else if (placeType === 'dependent state' || placeType === 'nation')
              placeType = 'A.ADM0';
            else if (placeType === 'province' || placeType === 'state')
              placeType = 'A.ADM1';
            else
              placeType = 'P.PPL';

           const location = new AtlasLocation();

            location.city = city;
            location.county = county;
            location.state = state;
            location.country = country;
            location.longCountry = longCountry;
            location.flagCode = getFlagCode(country, state);
            location.placeType = placeType;
            location.variant = variant;
            location.source = SOURCE_GETTY_UPDATE;

            if (!matchingLocationFound(keyedPlaces, location) &&
                !matchingLocationFound(altKeyedPlaces, location))
            {
              ++matchCount;
              location.zone = getTimeZone(location);

              if (asAlternate) {
                altKeyedPlaces.set(key, location);
              }
              else {
                keyedPlaces.set(key, location);
              }
            }
          }
        }
      }
    }

    // Never read more than 6 pages, and don't keep going if at least
    // 50 matches have been found. If the match rate is high in the first
    // two of pages or more, don't go any further than that.

  } while (theresMore && page < 6 && matchCount < 50 && !(page > 1 && matchCount >= page * 12));

  if (matchCount === 0 && !goodFormat)
    throw new Error('Failed to parse Getty data.');

  if (keyedPlaces.size === 0)
    keyedPlaces = altKeyedPlaces;
  else if (keyedPlaces.size + altKeyedPlaces.size < 25)
    altKeyedPlaces.forEach((value, key) => keyedPlaces.set(key, value));

  return keyedPlaces;
}

async function geoNamesSearch(targetCity: string, targetState: string, doZip: boolean, metrics: GeoNamesMetrics, notrace: boolean): Promise<LocationMap> {
  return timedPromise(geoNamesSearchAux(targetCity, targetState, doZip, metrics, notrace), MAX_TIME_GEONAMES * 1000, 'GeoNames search timed out');
}

async function geoNamesSearchAux(targetCity: string, targetState: string, doZip: boolean, metrics: GeoNamesMetrics, notrace: boolean): Promise<LocationMap> {
  const startTime = processMillis();
  const keyedPlaces = new LocationMap();

  targetCity = targetCity.replace(/^mt\b/i, 'mount');
  metrics = metrics ? metrics : {} as GeoNamesMetrics;
  metrics.matchedCount = 0;

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

  let geonames: any[];
  const options = {headers: {'User-Agent': FAKE_USER_AGENT}};
  let results: any;

  try {
    results = JSON.parse(await getWebPage(url, options));
  }
  catch (err) {
    throw new Error('GeoNames error: ' + err);
  }

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
          keyedPlaces.set(makeLocationKey(location.city, location.state, location.country, keyedPlaces), location);
          ++metrics.matchedCount;
        }
      }

      return true;
    });
  }

  metrics.retrievalTime = processMillis() - startTime;

  return keyedPlaces;
}

function logWarning(message: string, notrace = true): void {
  console.warn(message, notrace);
}

notFoundForEverythingElse(router);
