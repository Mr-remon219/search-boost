/** Official plugin-manager direct-dependency precedence, shared by every lifecycle path. */
export function dshDependencies(pkg) {
  return { ...pkg.devDependencies, ...pkg.dependencies, ...pkg.optionalDependencies }
}

export function dshRegistersBundle(pkg, name) {
  const bundles = pkg.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string')) throw new Error('Invalid DSH bundle list; registration was not verified.')
  // Registration/removal inspects every field, even when an optional edge
  // overrides a dependency edge during resolution.
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some(field => Object.hasOwn(pkg[field] ?? {}, name)) || bundles.includes(name)
}
