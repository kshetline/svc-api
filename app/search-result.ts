import { AtlasLocation } from './atlas-location';

export class SearchResult {
  originalSearch: string;
  normalizedSearch: string;
  time: number;
  error: string;
  warning: string;
  info: string;
  limitReached: boolean;
  matches: AtlasLocation[];

  constructor(originalSearch?: string, normalizedSearch?: string) {
    this.originalSearch = originalSearch;
    this.normalizedSearch = normalizedSearch;
  }

  get count(): number {
    return this.matches ? this.matches.length : 0;
  }

  set count(newValue: number) { /* Allow but ignore so this can be set via JSON without causing an error. */ }

  appendInfoLine(line: string): void {
    if (this.info)
      this.info += '\n' + line;
    else
      this.info = line;
  }

  appendWarningLine(line: string): void {
    if (this.warning)
      this.warning += '\n' + line;
    else
      this.warning = line;
  }

  toJSON(): any {
    const copy: any = {};

    Object.assign(copy, this);
    copy.count = this.count;

    return copy;
  }
}
