/**
 * bin entry for dsh-dep-audit.
 * @module dsh-dep-audit/bin
 */

import { main } from './cli.js'

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})