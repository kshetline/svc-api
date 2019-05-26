import { clone } from 'lodash';

export class Hash<T extends keyof any, U> {
  private _length = 0;
  private hash: Record<T, U> = {} as Record<T, U>;
  private _keys = new Set<T>();

  get length(): number { return this._length; }

  put(key: T, value: U): void {
    if (value !== undefined) {
      if (this.hash[key] === undefined)
        ++this._length;

      this.hash[key] = value;
      this._keys.add(key);
    } else if (this.hash[key] !== undefined) {
      --this._length;
      delete this.hash[key];
      this._keys.delete(key);
    }
  }

  get(key: T): U {
    return this.hash[key];
  }

  remove(key: T): void {
    if (this.hash[key] !== undefined) {
      --this._length;
      delete this.hash[key];
      this._keys.delete(key);
    }
  }

  contains(key: T): boolean {
    return this.hash[key] !== undefined;
  }

  clear(): void {
    this._length = 0;
    this.hash = {} as Record<T, U>;
  }

  get keys(): T[] {
    return Array.from(this._keys.keys());
  }

  get values(): U[] {
    const values: U[] = [];

    this.keys.forEach(key => values.push(this.hash[key]));

    return values;
  }

  forEach(fn: (value: U, key?: T) => void): void {
    // noinspection JSUnfilteredForInLoop
    for (const key in this._keys.keys())
      fn(this.hash[key as T], key as T);
  }

  asPlainObject(): Record<T, U> {
    return clone(this.hash);
  }
}
