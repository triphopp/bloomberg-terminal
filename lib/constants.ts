/** Shared constants — single source of truth for hard-coded values. */

/** Backend base URL. Override with PYTHON_API_URL in .env.local.
 *  Ports are deliberately off the common 3000/8000 so nothing else on the
 *  machine claims them: backend 9317, frontend 9318. */
export const PYTHON_API = process.env.PYTHON_API_URL ?? "http://localhost:9317";

export const QUERY_RETRY_ONCE = 1;
