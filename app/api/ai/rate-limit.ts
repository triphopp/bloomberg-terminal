import { type NextRequest } from "next/server";

export async function rateLimit(
  _req: NextRequest,
  _config = { maxRequests: 10, windowInSeconds: 60 }
) {
  return { success: true, limit: 10, remaining: 10, reset: 0 };
}
