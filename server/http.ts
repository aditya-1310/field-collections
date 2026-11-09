import { createHash } from 'node:crypto';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const id = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Expected a valid ID.',
  )
  .transform((value) => value.toLowerCase());
export const date = z.iso.date();
export const amount = z
  .number()
  .min(0)
  .max(1e9)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-5,
    'Use at most two decimal places.',
  );
export const note = z.string().trim().min(1).max(500);
export const checksum = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export function dateText(value: unknown): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

export function instant(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function shiftDay(day: string, days: number) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']';
  const object = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(object[key]))
      .join(',') +
    '}'
  );
}

export const decodeJson = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;
