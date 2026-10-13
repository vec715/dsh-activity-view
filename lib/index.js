/**
 * dsh-activity-view, host half.
 *
 * The feature is browser-only. This file exists so the package is a loadable
 * bundle row: `dsh.bundle.patch` inserts the row, the row names this package,
 * and `dsh.client` hangs the browser half off the same name. Nothing runs in
 * the host process.
 */
export const name = 'dsh-activity-view'

export function apply() {}
