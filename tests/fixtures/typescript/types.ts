export interface Repository<T> {
  readonly size: number;
  get(id: Identifier): T | undefined;
  map<U>(transform: (value: T) => U): Repository<U>;
}

export type Identifier = string | number;

export type Timestamped<T> = T & {
  createdAt: Date;
  updatedAt: Date;
};

export type UnwrapPromise<T> = T extends Promise<infer Value> ? Value : T;

export type Optional<T> = {
  [Key in keyof T]?: T[Key];
};

export enum Status {
  Idle = "idle",
  Running = "running",
  Complete = "complete",
}

export namespace Parsing {
  export interface Options {
    strict: boolean;
  }

  export type Result<T> = {
    value: T;
    warnings: string[];
  };
}
