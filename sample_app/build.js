"use strict";

require("esbuild").build({
  absWorkingDir: __dirname,
  entryPoints: ["src/app.js"],
  outfile: "public/app.bundle.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2020"],
  // SIP.js 0.13 uses global.window for its browser environment.
  define: { global: "globalThis" },
}).catch(() => { process.exitCode = 1; });
