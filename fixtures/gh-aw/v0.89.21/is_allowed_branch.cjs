// Extracted verbatim from github/gh-aw v0.89.21, actions/setup/js/safe_outputs_handlers.cjs
// (blob ef2a42e3c1edc8c046219c47923b3d8fceb370a5), lines 315-334: the function that decides
// create-pull-request's allowed-branches. MIT, see LICENSE. Only the require and the export are added.
// @ts-check
const { globPatternToRegex } = require("./glob_pattern_helpers.cjs");

/**
 * @param {string} branch
 * @param {string[]} allowedPatterns
 * @returns {boolean}
 */
function isAllowedBranch(branch, allowedPatterns) {
  for (const pattern of allowedPatterns) {
    if (branch === pattern) {
      return true;
    }
    if (pattern === "*") {
      // Add this fast-path
      return true;
    }
    if (pattern.includes("*") && globPatternToRegex(pattern, { pathMode: true, caseSensitive: true }).test(branch)) {
      return true;
    }
  }
  return false;
}

module.exports = { isAllowedBranch };
