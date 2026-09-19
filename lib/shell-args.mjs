/**
 * Shell-argument rendering for human copy-paste hints.
 *
 * These strings are printed for a user to paste, so an argument carrying
 * whitespace (very common on Windows: "C:\Program Files\...") must survive the
 * shell. Only whitespace and quotes trigger quoting, so hints that never needed
 * quotes keep their exact previous form.
 */

/** @param {unknown} value @returns {string} */
export function shellArg(value) {
  const s = String(value)
  return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/** @param {unknown[]} args @returns {string} */
export function shellArgs(args) {
  return args.map(shellArg).join(' ')
}
