import { Request, Response, Router } from 'express';

import { asyncHandler, makePlainASCII_UC, notFoundForEverythingElse, processMillis, toInt } from './common';
import { pool } from './atlas_database';
import {
  closeMatchForState, code3ToName, countyStateCleanUp, getFlagCode, initGazetteer, LocationMap, longStates,
  makeLocationKey, roughDistanceBetweenLocationsInKm, simplify
} from './gazetteer';
import { SearchResult } from './search-result';
import { AtlasLocation } from './atlas-location';
import { MapClass } from './map-class';
import { GettyMetrics, gettySearch } from './getty-search';
import { initTimezones } from './timezones';
import { GeoNamesMetrics, geoNamesSearch } from './geo-names-search';
import { PoolConnection } from './mysql-await-async';

export const router = Router();

type RemoteMode = 'skip' | 'normal' | 'extend' | 'forced' | 'only' | 'geonames' | 'getty';
type ParseMode = 'loose' | 'strict';

enum MatchType {EXACT_MATCH = 0, EXACT_MATCH_ALT, STARTS_WITH, SOUNDS_LIKE}

interface ParsedSearchString {
  targetCity: string;
  targetState: string;
  doZip: boolean;
  actualSearch: string;
  normalizedSearch: string;
}

class LocationArrayMap extends MapClass<string, AtlasLocation[]> {}

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
    await initGazetteer();
  }
  catch (err) {
    console.error('atlas init error: ' + err);
  }
}

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const q = req.query.q ? req.query.q.trim() : 'Nashua, NH';
  const version = toInt(req.query.version, 9);
  const remoteMode = (/skip|normal|extend|forced|only|geonames|getty/i.test(req.query.remote) ? req.query.remote.toLowerCase() : 'skip') as RemoteMode;
  const withoutDB = /only|geonames|getty/i.test(remoteMode);
  const extend = (remoteMode === 'extend' || remoteMode === 'only' || remoteMode === 'forced');
  const limit = Math.min(toInt(req.query.limit, DEFAULT_MATCH_LIMIT), MAX_MATCH_LIMIT);
  let dbError: string;
  let gotBetterMatchesFromRemoteData = false;

  const parsed = parseSearchString(q, version < 3 ? 'loose' : 'strict');
  const startTime = processMillis();

  const result = new SearchResult(q, parsed.normalizedSearch);
  let consultRemoteData = false;
  let remoteSearchResults;
  let dbMatchedOnlyBySound = false;
  let dbMatches: LocationMap;

  for (let attempt = 0; attempt < 2; ++attempt) {
    const connection = await pool.getConnection();

    if (/forced|only|geonames|getty/i.test(remoteMode) ||
        (remoteMode !== 'skip' && !(await hasSearchBeenDoneRecently(connection, parsed.normalizedSearch, extend))))
    {
      consultRemoteData = true;
    }

    // if (startTime / 1000 > lastInit + REFRESH_TIME_FOR_INIT_DATA) {
    //   initTimeZones(connection);
    //   initFlagCodes();
    //   lastInit = Util.elapsedTimeSeconds();
    // }

    if (withoutDB)
      dbMatches = undefined;
    else {
      try {
        dbMatches = await doDataBaseSearch(connection, parsed, extend, limit + 1);
        dbMatchedOnlyBySound = true;

        dbMatches.values.every(location => {
          if (!location.matchedBySound)
            dbMatchedOnlyBySound = false;

          return !dbMatchedOnlyBySound;
        });

        dbError = undefined;
      }
      catch (err) {
        dbError = err.toString();

        if (attempt === 0)
          continue;
      }
    }

    connection.release();

    if (consultRemoteData) {
      const doGeonames = remoteMode !== 'getty';
      const doGetty = remoteMode !== 'geonames';

      remoteSearchResults = await remoteSourcesSearch(parsed, doGeonames, doGetty, false);

      if (remoteSearchResults.matches > 0 && dbMatchedOnlyBySound) {
        gotBetterMatchesFromRemoteData = true;
        dbMatches = undefined;
      }
    }

    break;
  }

  const mergedMatches = new LocationArrayMap();

  if (dbMatches)
    copyAndMergeLocations(mergedMatches, dbMatches);

  if (remoteSearchResults) {
    if (remoteSearchResults.geoNamesMatches)
      copyAndMergeLocations(mergedMatches, remoteSearchResults.geoNamesMatches);

    if (remoteSearchResults.gettyMatches)
      copyAndMergeLocations(mergedMatches, remoteSearchResults.gettyMatches);
  }

  const uniqueMatches = eliminateDuplicates(mergedMatches, limit + 1);

  if (uniqueMatches.length > limit) {
    uniqueMatches.length = limit;
    result.limitReached = true;
  }

  console.log(dbError, gotBetterMatchesFromRemoteData);

  result.matches = uniqueMatches;
  result.time = processMillis() - startTime;

  res.send(result);
}));

function parseSearchString(q: string, mode: ParseMode) {
  const parsed = {doZip: false, actualSearch: q} as ParsedSearchString;
  const parts = q.split(',');
  let targetCity = parts[0];
  let targetState = parts[1] ? parts[1].trim() : '';
  let targetCountry = parts[2] ? parts[2].trim() : '';
  let $: string[];

  // US ZIP codes
  if (($ = US_ZIP_PATTERN.exec(targetCity))) {
    targetCity = $[1];
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

  if (mode === 'loose' && !targetState && ($ = TRAILING_STATE_PATTERN.exec(targetCity))) {
    const start = $[1].trim();
    const end = $[2];

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

function copyAndMergeLocations(destination: LocationArrayMap, source: LocationMap): void {
  source.keys.forEach(key => {
    const location = source.get(key);
    let locations: AtlasLocation[];

    key = key.replace(/\(\d+\)$/, '');

    if (destination.has(key))
      locations = destination.get(key);
    else {
      locations = [];
      destination.set(key, locations);
    }

    locations.push(location);
  });
}

const MATCH_ADM  = /^A\.ADM/i;
const MATCH_PPL  = /^P\.PPL/i;
const MATCH_PPLX = /^P\.PPL\w/i;

function eliminateDuplicates(mergedMatches: LocationArrayMap, limit: number): AtlasLocation[] {
  const keys = mergedMatches.keys.sort();

  keys.forEach(key => {
    const locations = mergedMatches.get(key);

    for (let i = 0; i < locations.length - 1; ++i) {
      const location1 = locations[i];

      if (!location1)
        continue;

      const city1       = location1.city;
      const county1     = location1.county;
      const state1      = location1.state;
      const country1    = location1.country;
      const latitude1   = location1.latitude;
      const longitude1  = location1.longitude;
      let zone1       = location1.zone;
      const zip1        = location1.zip;
      const rank1       = location1.rank;
      let placeType1  = location1.placeType;
      const source1     = location1.source;
      const geonameID1  = location1.geonameID;

      if (!zone1)
        zone1 = '?';

      for (let j = i + 1; j < locations.length; ++j) {
        const location2 = locations[j];

        if (!location2)
          continue;

        const county2     = location2.county;
        const state2      = location2.state;
        const latitude2   = location2.latitude;
        const longitude2  = location2.longitude;
        let zone2       = location2.zone;
        const zip2        = location2.zip;
        const rank2       = location2.rank;
        let placeType2  = location2.placeType;
        const source2     = location2.source;
        const geonameID2  = location2.geonameID;

        if (zone2 == null)
          zone2 = '?';

        if (MATCH_ADM.test(placeType1) && MATCH_PPL.test(placeType2))
          placeType1 = placeType2;

        if (MATCH_ADM.test(placeType2) && MATCH_PPL.test(placeType1))
          placeType2 = placeType1;

        if (MATCH_PPL.test(placeType1) && MATCH_PPLX.test(placeType2))
          placeType1 = placeType2;

        if (MATCH_PPL.test(placeType2) && MATCH_PPLX.test(placeType1))
          placeType2 = placeType1;

        const distance = roughDistanceBetweenLocationsInKm(latitude1, longitude1, latitude2, longitude2);

        // If locations are close and one location has a questionable time zone, but the other is more
        // certain, use the more certain time zone for both locations.
        if (distance < 10) {
          if (zone1.endsWith('?') && !zone2.endsWith('?'))
            location1.zone = zone2;
          else if (zone2.endsWith('?') && !zone1.endsWith('?'))
            location2.zone = zone1;
        }

        // Newer GeoNames data for the same location should replace older.
        if (geonameID1 && geonameID1 === geonameID2) {
          if (source1 > source2) {
            locations[j] = undefined;
            location1.rank = Math.max(rank1, rank2);
            location1.zip = (zip1 ? zip1 : zip2);
            location1.source = source2;
            location1.useAsUpdate = !location1.isCloseMatch(location2);
          }
          else {
            locations[i] = undefined;
            location2.rank = Math.max(rank1, rank2);
            location1.zip = (zip2 ? zip2 : zip1);
            location2.source = source1;
            location2.useAsUpdate = (source2 > source1 && !location2.isCloseMatch(location1));
            // After eliminating location1 (index i), end j loop since there's nothing left from the outer loop for inner
            // loop locations to be compared to.
            break;
          }
        }
        else if (distance < 10 && placeType2 === 'T.PK' && placeType1 === 'T.MT') {
          locations[i] = undefined;
          break;
        }
        // Favor peak (T.PK) place types over mountain (T.MT) place types.
        else if (distance < 10 && placeType1 === 'T.PK' && placeType2 === 'T.MT') {
          locations[j] = undefined;
        }
        else if (placeType1 !== placeType2) {
          // Do nothing - differing place types of non-city items will be noted.
        }
        else if (state1 !== state2) {
          if (distance < 10 && state1 && state2)
            console.warn(`Possible detail conflict for same location: ${city1}, ${state1}/${state2}, ${country1}`);

          if (rank2 > rank1) {
            locations[i] = undefined;
            break;
          }
          else if (rank1 > rank2 || !state2) {
            locations[j] = undefined;
          }
          else if (!state1) {
            locations[i] = undefined;
            break;
          }
          else {
            location1.showState = true;
            location2.showState = true;
          }
        }
        else if (county1 !== county2) {
          if (distance < 10 && county1 && county2)
            console.warn(`Possible detail conflict for same location: ${city1}, ${county1}/${county2}, ${state1}, ${country1}`);

          if (rank2 > rank1) {
            locations[i] = undefined;
            break;
          }
          else if (rank1 > rank2 || !county2)
            locations[j] = undefined;
          else if (!county1) {
            locations[i] = undefined;
            break;
          }
          else {
            location1.showCounty = true;
            location2.showCounty = true;
          }
        }
        else if (rank2 > rank1) {
          if (source1 < MIN_EXTERNAL_SOURCE && source2 >= MIN_EXTERNAL_SOURCE) {
            // Favor SVC's database entry, but keep higher rank.
            locations[j] = undefined;
            location1.rank = rank2;
          }
          else {
            locations[i] = undefined;
            break;
          }
        }
        else if ((zip1 && !zip2) || rank1 > rank2) {
          if (source2 < MIN_EXTERNAL_SOURCE && source1 >= MIN_EXTERNAL_SOURCE) {
            // Favor SVC's database entry, but keep higher rank.
            locations[i] = undefined;
            location2.rank = Math.max(rank1, rank2);
            location2.zip = (zip1 ? zip1 : zip2);
            break;
          }
          else
            locations[j] = undefined;
        }
        else if (source1 < MIN_EXTERNAL_SOURCE && source2 >= MIN_EXTERNAL_SOURCE)
          locations[j] = undefined;
        else {
          locations[i] = undefined;
          break;
        }
      }
    }
  });

  const uniqueMatches: AtlasLocation[] = [];

  keys.forEach(key => {
    const locations = mergedMatches.get(key);

    locations.forEach(location => {
      if (location && uniqueMatches.length < limit)
        uniqueMatches.push(location);
    });
  });

  return uniqueMatches.sort();
}

async function hasSearchBeenDoneRecently(connection: PoolConnection, searchStr: string, extended: boolean): Promise<boolean> {
  return await logSearchResults(connection, searchStr, extended, NO_RESULTS_YET, false);
}

async function logSearchResults(connection: PoolConnection, searchStr: string, extended: boolean, matchCount: number, dbUpdate: boolean): Promise<boolean> {
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

async function doDataBaseSearch(connection: PoolConnection, parsed: ParsedSearchString, extendedSearch: boolean, maxMatches: number): Promise<LocationMap> {
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

async function remoteSourcesSearch(parsed: ParsedSearchString, doGeonames: boolean, doGetty: boolean, notrace: boolean): Promise<RemoteSearchResults> {
  const results = {} as RemoteSearchResults;

  results.geoNamesMetrics = {} as GeoNamesMetrics;
  results.gettyMetrics = {} as GettyMetrics;

  const promises: Promise<LocationMap>[] = [];
  let geoNamesIndex = -1;
  let gettyIndex = -1;
  let nextIndex = 0;
  let noErrors = true;
  let matches = 0;

  if (doGeonames) {
    geoNamesIndex = nextIndex++;
    promises.push(geoNamesSearch(parsed.targetCity, parsed.targetState, parsed.doZip, results.geoNamesMetrics, notrace));
  }

  if (doGetty && !parsed.doZip) {
    gettyIndex = nextIndex++;
    promises.push(gettySearch(parsed.targetCity, parsed.targetState, results.gettyMetrics, notrace));
  }

  const locationsOrErrors = await Promise.all(promises.map(promise => promise.catch(err => err)));

  if (geoNamesIndex >= 0) {
    if (locationsOrErrors[geoNamesIndex] instanceof Error) {
      results.geoNamesError = (locationsOrErrors[geoNamesIndex] as Error).message;
      noErrors = false;
    }
    else {
      results.geoNamesMatches = locationsOrErrors[geoNamesIndex];
      matches += results.geoNamesMatches.size;
    }
  }

  if (gettyIndex >= 0) {
    if (locationsOrErrors[gettyIndex] instanceof Error) {
      results.gettyError = (locationsOrErrors[gettyIndex] as Error).message;
      noErrors = false;
    }
    else {
      results.gettyMatches = locationsOrErrors[gettyIndex];
      matches += results.gettyMatches.size;
    }
  }

  results.noErrors = noErrors;
  results.matches = matches;

  return results;
}

notFoundForEverythingElse(router);
