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
// Workspace packages are still symlinked even with a hoisted linker.
config.resolver.unstable_enableSymlinks = true;
// Hierarchical lookup stays ON: with node-linker=hoisted (see .npmrc) Metro
// needs to walk up to the root node_modules to find Expo's transitive native
// modules. Disabling it is what breaks the bundle with "Unable to resolve
// module expo-modules-core".
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
