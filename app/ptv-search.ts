import { LocationMap, simplify } from './gazetteer';
import { SOURCE_PTV, timedPromise } from './common';
import { processMillis } from '@tubular/util';
import { requestJson } from 'by-request';
import { getTimezoneForLocation, TzInfo } from './zone-for-location';
import { AtlasLocation } from './atlas-location';
import { ceil } from '@tubular/math';

export interface PtvMetrics {
  totalTime: number;
  retrievalTime: number;
  matchedCount: number;
  retrievedCount: number;
  complete: boolean;
  error: string;
}

interface PtvLocations {
  referencePosition?: {
    latitude: number;
    longitude: number;
  },
  address?: {
    countryName: string;
    state: string;
    province: string;
    postalCode: string;
    city: string;
    district: string;
    subdistrict: string;
    street: string;
    houseNumber: string;
  },
  formattedAddress?: string;
  locationType?: string; // LOCALITY
  quality?: {
    totalScore: number;
  }
}

interface PtvData {
  locations?: PtvLocations[];
}

const MAX_PTV_GETTY = 30; // seconds

export async function ptvSearch(query: string, language: string, metrics?: PtvMetrics, noTrace?: boolean): Promise<LocationMap> {
  return timedPromise(ptvSearchAux(query, language, metrics, noTrace), MAX_PTV_GETTY * 1000, 'PTV search timed out');
}

export async function ptvSearchAux(query: string, language: string, metrics?: PtvMetrics, _noTrace: boolean = false): Promise<LocationMap> {
  const simplified = simplify(query);
  const startTime = processMillis();
  const apiKey = encodeURIComponent(process.env.PTV_API_KEY);
  const searchText = encodeURIComponent(query);
  const url = `https://api.myptv.com/geocoding/v1/locations/by-text?apiKey=${apiKey}&language=${language}&searchText=${searchText}`;
  const data = await requestJson(url) as PtvData;
  const retrievalTime = processMillis() - startTime;
  const result = new LocationMap();
  let key = 0;

  if (data.locations?.length > 0) {
    for (const loc of data.locations) {
      if (!loc.address?.city || loc.locationType !== 'LOCALITY' || !simplify(loc.address.city).startsWith(simplified))
        continue;

      let zoneInfo: TzInfo;

      try {
        zoneInfo = await getTimezoneForLocation(loc.referencePosition.latitude, loc.referencePosition.longitude);
      }
      catch {
        continue;
      }

      if (zoneInfo?.timeZoneName)
        result.set((key++).toString(), Object.assign(new AtlasLocation(), {
          city: loc.address.city,
          country: zoneInfo.country || loc.address.countryName,
          longCountry: loc.address.countryName,
          state: loc.address.state || loc.address.province,
          placeType: 'P.PPL',
          latitude: loc.referencePosition.latitude,
          longitude: loc.referencePosition.longitude,
          rank: ceil(loc.quality.totalScore * 7 / 100),
          zone: zoneInfo.timeZoneName,
          source: SOURCE_PTV
        }));
    }
  }

  if (metrics) {
    metrics.totalTime = processMillis() - startTime;
    metrics.retrievalTime = retrievalTime;
    metrics.matchedCount = result.size;
    metrics.retrievedCount = data.locations?.length || 0;
    metrics.complete = true;
  }

  return result;
}
