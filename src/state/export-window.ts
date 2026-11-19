/** Latest successfully imported posted date, keyed by account alias. */
export type AccountHighWaterMarks = ReadonlyMap<string, string>;

export interface ExportWindow {
  /** Inclusive start. Null means the account has no prior import. */
  readonly from: string | null;
}

const millisecondsPerDay = 86_400_000;

export function nextExportWindow(
  latestPostedDate: string | undefined,
  overlapDays = 3,
): ExportWindow {
  if (!Number.isSafeInteger(overlapDays) || overlapDays < 0) {
    throw new RangeError('Overlap must be a nonnegative integer number of days');
  }
  if (latestPostedDate === undefined) return { from: null };

  const date = new Date(`${latestPostedDate}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(latestPostedDate) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== latestPostedDate
  ) {
    throw new RangeError('Latest posted date must be a valid YYYY-MM-DD date');
  }

  const earliest = Date.parse('0000-01-01T00:00:00.000Z');
  const start = Math.max(earliest, date.getTime() - overlapDays * millisecondsPerDay);
  return { from: new Date(start).toISOString().slice(0, 10) };
}
