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
}
