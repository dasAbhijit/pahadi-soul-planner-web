// The tests load the sheet script (plain CommonJS) with Node's createRequire. The app itself never uses Node.
declare module 'node:module' {
  export function createRequire(url: string | URL): (id: string) => unknown;
}

// The live Gemini check (test/live-gemini.eval.test.ts) reads two environment variables and writes one file.
declare module 'node:fs' {
  export function writeFileSync(path: string, data: string): void;
}
declare const process: { env: Record<string, string | undefined> };
