export class KeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeysError";
  }
}

/** Thrown by spendKeys / adjustKeys when the member doesn't have the keys. */
export class InsufficientKeysError extends KeysError {
  constructor(
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(`Not enough keys: ${requested} requested, ${available} available`);
    this.name = "InsufficientKeysError";
  }
}
