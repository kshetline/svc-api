import { Request, Response, Router } from 'express';
import mime from 'mime';

import { asyncHandler, MIN_EXTERNAL_SOURCE, notFoundForEverythingElse, processMillis, toBoolean, toInt } from './common';
import { doDataBaseSearch, hasSearchBeenDoneRecently, pool } from './atlas_database';
import { initGazetteer, LocationMap, ParsedSearchString, parseSearchString, roughDistanceBetweenLocationsInKm } from './gazetteer';
import { SearchResult } from './search-result';
import { AtlasLocation } from './atlas-location';
import { MapClass } from './map-class';
import { GettyMetrics, gettySearch } from './getty-search';
import { initTimezones } from './timezones';
import { GeoNamesMetrics, geoNamesSearch } from './geo-names-search';
import { svcApiConsole } from './svc-api-logger';

export const router = Router();

type RemoteMode = 'skip' | 'normal' | 'extend' | 'forced' | 'only' | 'geonames' | 'getty';

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

const DEFAULT_MATCH_LIMIT = 75;
const MAX_MATCH_LIMIT = 500;
const REFRESH_TIME_FOR_INIT_DATA = 86400; // seconds

let lastInit = 0;

export async function initAtlas(re_init = false) {
  try {
    await initTimezones();
    await initGazetteer();
    lastInit = processMillis();
  }
  catch (err) {
    svcApiConsole.error(`Atlas ${re_init ? 're-' : ''}init error: ${err}`);

    if (!re_init)
      throw (err);
  }
}

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const startTime = processMillis();

  const q = req.query.q ? req.query.q.trim() : 'Nashua, NH';
  const version = toInt(req.query.version, 9);
  const callback = req.query.callback;
  const plainText = toBoolean(req.query.pt, true);
  const remoteMode = (/skip|normal|extend|forced|only|geonames|getty/i.test(req.query.remote) ? req.query.remote.toLowerCase() : 'skip') as RemoteMode;
  const withoutDB = /only|geonames|getty/i.test(remoteMode);
  const extend = (remoteMode === 'extend' || remoteMode === 'only' || remoteMode === 'forced');
  const limit = Math.min(toInt(req.query.limit, DEFAULT_MATCH_LIMIT), MAX_MATCH_LIMIT);

  const parsed = parseSearchString(q, version < 3 ? 'loose' : 'strict');
  const result = new SearchResult(q, parsed.normalizedSearch);
  let consultRemoteData = false;
  let remoteSearchResults;
  let dbMatchedOnlyBySound = false;
  let dbMatches: LocationMap;
  let dbError: string;
  let gotBetterMatchesFromRemoteData = false;

  for (let attempt = 0; attempt < 2; ++attempt) {
    const connection = await pool.getConnection();

    if (/forced|only|geonames|getty/i.test(remoteMode) ||
        (remoteMode !== 'skip' && !(await hasSearchBeenDoneRecently(connection, parsed.normalizedSearch, extend))))
    {
      consultRemoteData = true;
    }

    if (startTime / 1000 > lastInit + REFRESH_TIME_FOR_INIT_DATA)
      await initAtlas(true);

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

  console.log(dbError, gotBetterMatchesFromRemoteData); // TODO: Remove

  result.matches = uniqueMatches;
  result.time = processMillis() - startTime;

  if (plainText) {
    res.set('Content-Type', mime.getType('.txt'));
    res.send(result.toPlainText());
  }
  else if (callback)
    res.jsonp(result);
  else
    res.send(result);
}));

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
            svcApiConsole.warn(`Possible detail conflict for same location: ${city1}, ${state1}/${state2}, ${country1}`);

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
            svcApiConsole.warn(`Possible detail conflict for same location: ${city1}, ${county1}/${county2}, ${state1}, ${country1}`);

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
    gettyIndex = nextIndex /* ++ */; // TODO: Put back trailing ++ if another remote source is added.
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
