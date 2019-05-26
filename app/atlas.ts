import { Request, Response, Router } from 'express';
import { https } from 'follow-redirects';

import { asyncHandler, eqci, makePlainASCII_UC, notFoundForEverythingElse, processMillis, toInt } from './common';
import { Connection, pool } from './database';
import { code3ToCode2, code3ToName, initGazetteer, longStates, new3ToOld2, simplify } from './gazetteer';
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

const zoneLookup: Record<string, string> = {};

const US_ZIP_PATTERN = /(\d{5})(-\d{4,6})?/;
const OTHER_POSTAL_CODE_PATTERN = /[0-9A-Z]{2,8}((-|\s+)[0-9A-Z]{2,6})?/i;
const TRAILING_STATE_PATTERN = /(.+)\b(\w{2,3})$/;

const NO_RESULTS_YET = -1;
const MAX_MONTHS_BEFORE_REDOING_EXTENDED_SEARCH = 12;
const DEFAULT_MATCH_LIMIT = 75;
const MAX_MATCH_LIMIT = 500;
const MIN_EXTERNAL_SOURCE = 100;
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
      if (res.statusCode === 200) {
        res.on('data', (data: Buffer) => {
          const lines = data.toString('utf8').split(/\r\n|\n|\r/);

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

function isCloseMatchForState(target: string, state: string, country: string): boolean {
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

        if (!isCloseMatchForState(parsed.targetState, state, country))
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

notFoundForEverythingElse(router);
