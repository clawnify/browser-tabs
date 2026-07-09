// Compiled entry. tsc produces dist/index.js from this — what
// `package.json#main` and the OpenClaw loader (npm install, no TS support)
// consume. The root `index.ts` is the TS-direct entry used by
// openclaw.extensions when the host has TS support; both re-export the same
// plugin default.

export { default } from "./plugin/index.js";
