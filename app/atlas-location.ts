import { KsTimeZone } from 'ks-date-time-zone';
import { eqci } from './common';

function addParenthetical(s: string): string {
  return ` (${s})`;
}

const CENSUS_AREAS = new RegExp(
  '(Aleutians West|Bethel|Dillingham|Nome|Prince of Wales-Outer Ketchikan|' +
  'Skagway-Hoonah-Angoon|Southeast Fairbanks|Valdez-Cordova|Wade Hampton|' +
  'Wrangell-Petersburg|Yukon-Koyukuk)', 'i');

function adjustUSCountyName(county: string, state: string): string {
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

export class AtlasLocation {
  city: string;
  variant: string;
  county: string;
  showCounty: boolean;
  state: string;
  showState: boolean;
  country: string;
  longCountry: string;
  flagCode: string;
  latitude: number;
  longitude: number;
  elevation: number;
  zone: string;
  zip: string;
  rank: number;
  placeType: string;
  source: number;
  matchedByAlternateName = false;
  matchedBySound = false;
  geonameID?: number;
  useAsUpdate?: boolean;

  getZoneOffset(): number {
    const zoneName = /(.*?)(\?)?$/.exec(this.zone)[1];
    const zone = KsTimeZone.getTimeZone(zoneName);

    return zone.utcOffset;
  }

  getZoneDst(): number {
    const zoneName = /(.*?)(\?)?$/.exec(this.zone)[1];
    const zone = KsTimeZone.getTimeZone(zoneName);

    return zone.dstOffset;
  }

  get displayName(): string {
    let city = this.city;
    let county = this.county;
    let cityQualifier = '';
    let displayState;
    let stateQualifier = '';
    let showState = this.showState;

    if (this.country === 'USA' || this.country === 'CAN' && this.placeType !== 'A.ADM0') {
      if (this.placeType !== 'A.ADM1')
        displayState = this.state;
      else
        displayState = this.country;

      if (this.country === 'USA') {
        if (this.placeType === 'A.ADM2')
          city = adjustUSCountyName(city, this.state);
        else
          county = adjustUSCountyName(county, this.state);
      }
    }
    else {
      displayState = this.country;

      if (this.country === 'GBR' && this.state) {
        stateQualifier = addParenthetical(this.state);
        showState = false;
      }
      else if (this.longCountry && this.placeType !== 'A.ADM0')
        stateQualifier = addParenthetical(this.longCountry);
    }

    if (county && this.showCounty)
      cityQualifier = addParenthetical(county);

    if (this.state && showState)
      stateQualifier += addParenthetical(this.state);

    if (this.placeType === 'T.CAPE')
      stateQualifier += ' (cape)';
    else if (this.placeType === 'H.LK')
      stateQualifier += ' (lake)';
    else if (this.placeType === 'L.PRK')
      stateQualifier += ' (park)';
    else if (this.placeType === 'T.PK')
      stateQualifier += ' (peak)';
    else if (this.placeType === 'L.MILB')
      stateQualifier += ' (military base)';
    else if (this.placeType === 'A.ADM2') {
      if (/ (Borough|Census Area|County|Division|Parish)/i.test(city)) {
        stateQualifier += ' (county)';
      }
    }
    else if (this.placeType === 'T.ISL')
      stateQualifier += ' (island)';
    else if (this.placeType === 'S.ASTR' || this.placeType === 'T.POLE')
      stateQualifier += ' (geographic point)';
    else if (this.placeType === 'T.MT')
      stateQualifier += ' (mountain)';
    else if (this.placeType === 'A.ADM0')
      stateQualifier += ' (nation)';
    else if (this.placeType === 'S.OBS')
      stateQualifier += ' (observatory)';
    else if (this.placeType === 'A.ADM1' && this.country === 'CAN')
      stateQualifier += ' (province)';
    else if (this.placeType === 'A.ADM1' && this.country === 'USA')
      stateQualifier += ' (state)';

    return city + cityQualifier + (displayState ? ', ' + displayState : '') + stateQualifier;
  }

  set displayName(s: string) { /* Allow but ignore so this can be set via JSON without causing an error. */ }

  isCloseMatch(other: AtlasLocation): boolean {
    return eqci(this.city, other.city) &&
           eqci(this.variant, other.variant) &&
           eqci(this.county, other.county) &&
           eqci(this.state, other.state) &&
           eqci(this.country, other.country) &&
           Math.abs(this.latitude - other.latitude) < 0.0001 &&
           Math.abs(this.longitude - other.longitude) < 0.0001 &&
           this.elevation === other.elevation &&
           this.zone === other.zone &&
           this.zip === other.zip &&
           this.placeType === other.placeType;
  }

  toString(): string {
    return `${this.displayName}: ${this.latitude}, ${this.longitude}; ${this.zip}; ${this.zone}; ${this.placeType}; ${this.source}; ${this.rank}`;
  }

  toJSON(): any {
    const copy: any = {};

    Object.assign(copy, this);
    copy.displayName = this.displayName;
    delete copy.geonameID;
    delete copy.useAsUpdate;

    return copy;
  }
}
