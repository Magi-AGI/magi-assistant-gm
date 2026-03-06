declare module 'talisman/phonetics/double-metaphone.js' {
  export default function doubleMetaphone(word: string): [string, string];
}

declare module 'talisman/metrics/jaro-winkler.js' {
  export function similarity(a: string, b: string): number;
  export function distance(a: string, b: string): number;
}
