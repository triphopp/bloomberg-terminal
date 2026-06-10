// Alpha Vantage removed — stubs kept for legacy imports

export function generateRandomSparkline(): number[] {
  return Array.from({ length: 8 }, () => Math.min(1, Math.max(0, Math.random())));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function fetchFinancialNews(_query?: string): Promise<null> {
  return null;
}
