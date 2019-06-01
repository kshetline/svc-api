import { Pool, PoolConnection } from './mysql-await-async';
import { closeMatchForState, code3ToName, countyStateCleanUp, getFlagCode, LocationMap, makeLocationKey, ParsedSearchString, simplify } from './gazetteer';
import { AtlasLocation } from './atlas-location';

export const pool = new Pool({
  host: (process.env.DB_REMOTE ? 'skyviewcafe.com' : '127.0.0.1'),
  user: 'skyview',
  password: process.env.DB_PWD,
  database: 'skyviewcafe'
});

enum MatchType {EXACT_MATCH = 0, EXACT_MATCH_ALT, STARTS_WITH, SOUNDS_LIKE}

const NO_RESULTS_YET = -1;
const MAX_MONTHS_BEFORE_REDOING_EXTENDED_SEARCH = 12;
const ZIP_RANK = 9;
const MIN_EXTERNAL_SOURCE = 100;

pool.on('connection', connection => {
  connection.query("SET NAMES 'utf8'");
});

export function logWarning(message: string, notrace = true): void {
  console.warn(message, notrace);
}

export async function hasSearchBeenDoneRecently(connection: PoolConnection, searchStr: string, extended: boolean): Promise<boolean> {
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

export async function doDataBaseSearch(connection: PoolConnection, parsed: ParsedSearchString, extendedSearch: boolean, maxMatches: number): Promise<LocationMap> {
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
