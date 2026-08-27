const noop = () => undefined;
const React = {
  createElement: () => null, Fragment: 'Fragment', forwardRef: (f) => f, memo: (f) => f,
  createContext: () => ({ Provider: null, Consumer: null }), useContext: () => ({}),
  useEffect: noop, useLayoutEffect: noop, useReducer: () => [null, noop],
  useRef: () => ({ current: null }), useCallback: (f) => f, useState: (v) => [v, noop],
  useMemo: (f) => f(),
};
module.exports = { ...React, default: React, __esModule: true };
