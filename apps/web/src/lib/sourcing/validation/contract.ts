import type { z } from "zod";

/** Every key across all members of a union. */
type AllKeys<T> = T extends unknown ? keyof T : never;

type SameKeys<A, B> = [AllKeys<A>] extends [AllKeys<B>]
  ? [AllKeys<B>] extends [AllKeys<A>]
    ? true
    : false
  : false;

/**
 * Compile-time guard that a schema matches a domain interface: the types are
 * mutually assignable and declare the same keys (so a schema cannot silently
 * miss an optional field). Applied per object level; nested objects get their
 * own check. Used as `export type _X = Assert<SchemaMatches<typeof s, X>>`;
 * `pnpm typecheck` fails if either side drifts.
 */
export type SchemaMatches<S extends z.ZodType, T> =
  [z.output<S>] extends [T]
    ? [T] extends [z.output<S>]
      ? SameKeys<z.output<S>, T> extends true
        ? true
        : { error: "schema and domain type declare different keys"; schema: z.output<S>; domain: T }
      : { error: "domain type is not assignable to the schema output"; schema: z.output<S>; domain: T }
    : { error: "schema output is not assignable to the domain type"; schema: z.output<S>; domain: T };

export type Assert<T extends true> = T;
