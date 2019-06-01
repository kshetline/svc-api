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

  toPlainText(): string {
    const text: string[] = [];
    const sorted = (this.matches ? this.matches.sort((a, b) => {
        if (a.rank < b.rank) // Descending rank order as primary sort
          return 1;
        else if (a.rank > b.rank)
          return -1;
        else if (a.displayName < b.displayName) // ...but ascending name order as secondary sort
          return -1;
        else if (a.displayName > b.displayName)
          return 1;
        else
          return 0;
      }) : this.matches);

    text.push(`originalSearch: ${this.originalSearch}`);
    text.push(`normalizedSearch: ${this.normalizedSearch}`);
    text.push(`time: ${(this.time / 1000).toFixed(3)} seconds`);

    if (this.error)
      text.push(`error: ${this.error}`);
    else {
      if (this.warning)
        text.push(`warning: ${this.warning.replace('\n', '\u23CE\n')}`);

      if (this.info)
        text.push(`warning: ${this.info.replace('\n', '\u23CE\n')}`);

      text.push(`count: ${this.count}` + (this.limitReached ? ' (limit reached)' : ''));

      if (sorted)
        sorted.forEach(match => text.push(match.toString()));
    }

    text.push('');

    return text.join('\n');
  }
}
