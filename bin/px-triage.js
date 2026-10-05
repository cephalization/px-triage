#!/usr/bin/env node
// Entry for the published package. Guard the Node version first so an old
// runtime gets a clear message instead of a syntax error from dist/.
const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`px-triage needs Node 22.12 or newer (found ${process.versions.node}).`)
  process.exit(1)
}
await import("../dist/main.js")
