/** Encodes one path segment (an ID). */
export const id = (v: string): string => encodeURIComponent(v);
