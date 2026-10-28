export class ScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerError";
  }
}
