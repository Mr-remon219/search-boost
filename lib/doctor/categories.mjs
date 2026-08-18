/** @typedef {'runtime'|'config'|'agents'|'engines'|'mcp'|'probe'} DoctorCategory */

/** @type {DoctorCategory[]} */
export const DOCTOR_CATEGORIES = ['runtime', 'config', 'agents', 'engines', 'mcp', 'probe']

/** @param {string} id @returns {id is DoctorCategory} */
export function isDoctorCategory(id) {
  return DOCTOR_CATEGORIES.includes(/** @type {DoctorCategory} */ (id))
}
