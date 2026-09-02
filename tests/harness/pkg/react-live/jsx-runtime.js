'use strict';
const { createElement } = require('./index.js');
// The third argument is React 17+'s `key`, hoisted out of props by the
// compiler. This runtime renders one component and keeps no keyed children, so
// it is deliberately ignored - named with the leading underscore the lint
// config sanctions rather than dropped, because the arity documents the
// signature esbuild's JSX transform calls.
const jsx = (type, props, _key) => {
  const { children, ...rest } = props || {};
  return children === undefined ? createElement(type, rest) : createElement(type, rest, children);
};
module.exports = { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: 'Fragment', __esModule: true };
