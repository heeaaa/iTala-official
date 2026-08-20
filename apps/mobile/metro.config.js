/**
 * Metro in a pnpm workspace.
 *
 * Two things are needed and neither is the default. Metro has to WATCH the
 * repository root so changes in packages/domain and packages/sync trigger a
 * reload, and it has to be told where to resolve modules from, because pnpm
 * uses a symlinked store rather than a flat node_modules. Without both, an
 * edit to the stat maths appears to do nothing until you restart the bundler.
 */
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// pnpm symlinks workspace packages; Metro must follow them rather than
// treating each as a separate project root.
config.resolver.unstable_enableSymlinks = true;
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
