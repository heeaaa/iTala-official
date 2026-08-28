// ESLint flat config (CODE_REVIEW.md F-09).
//
// Before this file the project had no lint tooling at all: `tests/static.test.js`
// enforced a set of bespoke structural invariants, but nothing checked unused
// imports, hook rules, or import ordering. The gap was tooling, not just CI
// wiring, so there was no "lint" step a workflow could even have called.
//
// The base is `eslint-config-expo`, matched to this project's SDK: SDK 54 ships
// with eslint-config-expo 10.x (later releases renumbered to track SDK numbers,
// so 55.x/56.x/57.x are for later SDKs and would pull the wrong plugin set).
// `eslint-config-prettier` comes last so Prettier owns formatting and ESLint
// owns correctness - the two never disagree about the same line.

const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

// Flat config only resolves a plugin-prefixed rule inside a config object that
// registers that plugin. Rather than `require`-ing @typescript-eslint,
// eslint-plugin-react and friends by name - they are transitive dependencies of
// eslint-config-expo, not direct dependencies of this project, so naming them
// here would break on any upgrade that reshuffles them - reuse whatever the
// Expo config already registered.
const expoPlugins = Object.assign({}, ...expoConfig.map(entry => entry.plugins || {}));

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.expo/**',
      'assets/**',
      // Static marketing/policy pages. Plain hand-written HTML and CSS with no
      // JS to lint; the privacy policy's content is guarded by CHECK 15 instead.
      'site/**',
    ],
  },

  ...expoConfig,

  {
    // The test suite is deliberately dependency-light: plain CommonJS Node
    // scripts run directly by `node tests/run.js`, not bundled or transpiled.
    // Without this they report `__dirname is not defined`, because the shared
    // config assumes ES modules in a React Native runtime.
    files: ['tests/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { __dirname: 'readonly', __filename: 'readonly', module: 'writable', require: 'readonly', process: 'readonly', console: 'readonly' },
    },
  },

  prettierConfig,

  {
    // Scoped to source files and handed the Expo config's own plugin registry,
    // which is what makes the plugin-prefixed rules below resolvable.
    files: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'],
    plugins: expoPlugins,
    rules: {
      // Not applicable to React Native. This rule stops a bare apostrophe
      // breaking HTML parsing; RN's <Text> renders its string children
      // literally and has no entity parsing, so "Player's" is correct as
      // written and escaping it would render a literal "&apos;" to the user.
      'react/no-unescaped-entities': 'off',

      // Promoted from warn to error. Every existing violation was fixed in the
      // same commit that added this file, so the gate starts clean and a new
      // unused import fails CI instead of accumulating. `_`-prefixed names stay
      // allowed for deliberately-ignored positional arguments and caught errors.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-unused-vars': 'off', // superseded by the TypeScript-aware rule above
      'import/first': 'error',

      // Promoted from warn to error now that F-14 has landed. The two violations
      // this was holding open - LiveGameScreen's score memo and milestone effect
      // depending on app-wide `state`, and FinalScoreScreen's promo memo keyed on
      // `activePromos.length` - are both gone, so the gate starts clean.
      //
      // Note for the next person tempted to silence this rule: FinalScoreScreen's
      // case was a memo that deliberately did NOT want to re-derive on a
      // dependency change. The fix was to express that as a lazily-filled ref
      // rather than to suppress the rule, because a suppression there would have
      // hidden the real F-14 violation sitting next to it.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
];
