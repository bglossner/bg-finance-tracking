export interface NormalizedTransaction {
  /** Signed integer in the account currency's minor units. */
  readonly amountMinor: number;
  /** Posted calendar date in YYYY-MM-DD format. */
  readonly postedDate: string;
  /** Stable source transaction ID for deduplication within the account. */
  readonly imported_id: string;
}

export interface SourceAdapter {
  parse(contents: string): readonly NormalizedTransaction[];
}
