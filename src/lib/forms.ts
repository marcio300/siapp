/** FormData → plain values for zod schemas (checkboxes, multi-selects, local date/time pairs). */
export function text(fd: FormData, key: string): string | undefined {
  const v = fd.get(key);
  return typeof v === "string" ? v : undefined;
}

export function checkbox(fd: FormData, key: string): boolean {
  return fd.get(key) === "on" || fd.get(key) === "true";
}

export function multi(fd: FormData, key: string): string[] {
  return fd.getAll(key).filter((v): v is string => typeof v === "string");
}

export function localDateTime(fd: FormData, key: string): { date?: string; time?: string } {
  return { date: text(fd, `${key}Date`) || undefined, time: text(fd, `${key}Time`) || undefined };
}
