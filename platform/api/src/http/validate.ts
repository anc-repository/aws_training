/**
 * Request validation: zod schemas → `400 VALIDATION_FAILED` with field errors (`errors[]{path, message}`), so that the
 * UI can put each message under its field (08 §8.6).
 */
import { z } from 'zod';
import { AtlError } from '@atl/shared';

export interface FieldError {
  path: string;
  message: string;
}

function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(body)', message: i.message }));
}

/** Parse a JSON body (an absent body counts as `{}`) against `schema`. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const errors = toFieldErrors(r.error);
    throw new AtlError('VALIDATION_FAILED', errors.map((e) => `${e.path}: ${e.message}`).join('; '), { errors });
  }
  return r.data;
}

/** Parse query parameters against `schema`. */
export function parseQuery<S extends z.ZodType>(schema: S, query: Record<string, string>): z.infer<S> {
  const r = schema.safeParse(query);
  if (!r.success) {
    const errors = toFieldErrors(r.error);
    throw new AtlError('VALIDATION_FAILED', errors.map((e) => `query ${e.path}: ${e.message}`).join('; '), { errors });
  }
  return r.data;
}

/** Path parameter guard (ids from the route table are untrusted strings). */
export function requireParam(params: Record<string, string>, name: string, pattern?: RegExp): string {
  const v = params[name];
  if (!v || (pattern && !pattern.test(v))) throw new AtlError('NOT_FOUND', `invalid ${name}`);
  return v;
}

export { z };
