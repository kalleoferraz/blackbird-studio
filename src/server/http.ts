import type { FastifyInstance } from 'fastify';

/** An error with an HTTP status and a short machine-readable code, turned into a JSON reply. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export const notFound = () => new HttpError(404, 'not_found');
export const forbidden = () => new HttpError(403, 'forbidden');
export const badRequest = (code = 'invalid_request', message?: string) => new HttpError(400, code, message);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.code, message: error.message, ...error.extra });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'invalid_request', message: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'server_error' });
  });
}

// ---- body readers ---------------------------------------------------------------

type Body = Record<string, unknown>;

export function asBody(body: unknown): Body {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Body) : {};
}

export function reqString(body: Body, key: string, max: number, { min = 1, trim = true } = {}): string {
  const v = body[key];
  if (typeof v !== 'string') throw badRequest(`invalid_${key}`);
  const s = trim ? v.trim() : v;
  if (s.length < min || s.length > max) throw badRequest(`invalid_${key}`);
  return s;
}

/** undefined when the key is absent; null when explicitly null (when allowed); otherwise a checked string. */
export function optString(body: Body, key: string, max: number, { allowNull = false, min = 0, trim = true } = {}): string | null | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null) {
    if (allowNull) return null;
    throw badRequest(`invalid_${key}`);
  }
  if (typeof v !== 'string') throw badRequest(`invalid_${key}`);
  const s = trim ? v.trim() : v;
  if (s.length < min || s.length > max) throw badRequest(`invalid_${key}`);
  return s;
}

export function optBool(body: Body, key: string): boolean | undefined {
  if (!(key in body)) return undefined;
  if (typeof body[key] !== 'boolean') throw badRequest(`invalid_${key}`);
  return body[key] as boolean;
}

export function optInt(body: Body, key: string, min: number, max: number): number | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badRequest(`invalid_${key}`);
  return v;
}
