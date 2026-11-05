// The tests load the sheet script (plain CommonJS) with Node's createRequire. The app itself never uses Node.
declare module 'node:module' {
  export function createRequire(url: string | URL): (id: string) => unknown;
}
