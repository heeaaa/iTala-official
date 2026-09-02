// A REAL (if tiny) React for the provider suite.
//
// tests/harness/pkg/react is a no-op stub: every hook returns a constant, so a
// component cannot run there at all. That is fine for the suites that import
// pure functions out of the app, and it is the reason StoreProvider itself has
// never been executed by a test - the sync suite hand-reimplements its dispatch
// wrapper and its boot ordering, which is exactly where a divergence hides.
//
// This runtime executes the component for real: hooks with per-slot state,
// effects with dependency comparison and cleanup, a reducer whose dispatches
// accumulate, and a render loop that settles. It renders ONE function component
// (the provider) and returns the element it produced, which is enough to reach
// the context value - and therefore `dispatch` - without a DOM or a host tree.
//
// It is deliberately NOT a React clone. No concurrency, no Suspense, no
// children rendering, no batching subtleties. Every difference from React that
// could matter to what is under test is listed in tests/provider.test.js.

'use strict';

let currentRoot = null;
let hookIndex = 0;

function slot(init) {
  const root = currentRoot;
  if (!root) throw new Error('react-live: hook called outside a render');
  const i = hookIndex++;
  if (root.hooks.length <= i) root.hooks[i] = init();
  return root.hooks[i];
}

const sameDeps = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

class Root {
  constructor(component, props) {
    this.component = component;
    this.props = props;
    this.hooks = [];
    this.dirty = true;
    this.unmounted = false;
    this.element = null;
    this.queue = [];   // effect slots whose deps changed this render
    this.renders = 0;
  }

  invalidate() {
    this.dirty = true;
  }

  renderOnce() {
    this.dirty = false;
    this.queue = [];
    const prev = currentRoot;
    const prevIndex = hookIndex;
    currentRoot = this;
    hookIndex = 0;
    try {
      this.element = this.component(this.props);
      this.renders++;
    } finally {
      currentRoot = prev;
      hookIndex = prevIndex;
    }
    // Effects run after the render that queued them, in declaration order,
    // with the previous cleanup first - the same order React uses, and the
    // order the provider's boot/autosave ordering depends on.
    const queued = this.queue;
    this.queue = [];
    for (const s of queued) {
      if (typeof s.cleanup === 'function') s.cleanup();
      s.cleanup = undefined;
      const out = s.fn();
      if (typeof out === 'function') s.cleanup = out;
    }
    return this.element;
  }

  // Render until nothing else asks for one. The cap turns an accidental
  // render loop into a test failure rather than a hang.
  flush() {
    let n = 0;
    while (this.dirty && !this.unmounted) {
      if (++n > 200) throw new Error('react-live: render loop did not settle');
      this.renderOnce();
    }
    return this.element;
  }

  unmount() {
    this.unmounted = true;
    for (const s of this.hooks) {
      if (s && s.kind === 'effect' && typeof s.cleanup === 'function') s.cleanup();
    }
  }
}

function useState(initial) {
  const root = currentRoot;
  const s = slot(() => ({
    kind: 'state',
    value: typeof initial === 'function' ? initial() : initial,
    set: (next) => {
      const v = typeof next === 'function' ? next(s.value) : next;
      if (Object.is(v, s.value)) return;
      s.value = v;
      root.invalidate();
    },
  }));
  return [s.value, s.set];
}

function useReducer(reducer, initial) {
  const root = currentRoot;
  const s = slot(() => ({
    kind: 'reducer',
    value: initial,
    // Applied eagerly rather than queued. The provider computes the next state
    // itself and keeps `stateRef` in step, so eager application matches what it
    // already assumes; what matters for the suite is that consecutive dispatches
    // accumulate and that a render follows.
    dispatch: (action) => {
      s.value = s.reducer(s.value, action);
      root.invalidate();
    },
  }));
  s.reducer = reducer;
  return [s.value, s.dispatch];
}

function useRef(initial) {
  return slot(() => ({ kind: 'ref', current: initial }));
}

function useMemo(fn, deps) {
  const s = slot(() => ({ kind: 'memo', deps: undefined, value: undefined, first: true }));
  if (s.first || !sameDeps(s.deps, deps)) {
    s.value = fn();
    s.deps = deps;
    s.first = false;
  }
  return s.value;
}

function useCallback(fn, deps) {
  return useMemo(() => fn, deps);
}

function useEffect(fn, deps) {
  const root = currentRoot;
  const s = slot(() => ({ kind: 'effect', deps: undefined, cleanup: undefined, first: true }));
  if (s.first || !sameDeps(s.deps, deps)) {
    s.deps = deps;
    s.first = false;
    s.fn = fn;
    root.queue.push(s);
  }
  return undefined;
}

function createContext(defaultValue) {
  const ctx = {
    _default: defaultValue,
    _current: defaultValue,
    Provider: function Provider(props) { return props.children ?? null; },
    Consumer: function Consumer() { return null; },
  };
  ctx.Provider._context = ctx;
  return ctx;
}

function useContext(ctx) {
  return ctx._current;
}

function createElement(type, props, ...children) {
  const p = { ...(props || {}) };
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  // A rendered Provider publishes its value, which is how the suite gets hold
  // of `dispatch` and the context the screens would read.
  if (type && type._context) type._context._current = p.value;
  return { type, props: p };
}

const React = {
  createElement,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect: useEffect,
  useReducer,
  useRef,
  useState,
  useMemo,
  useCallback,
  Fragment: 'Fragment',
  forwardRef: (f) => f,
  memo: (f) => f,
};

function render(component, props) {
  const root = new Root(component, props);
  root.flush();
  return root;
}

module.exports = { ...React, default: React, __esModule: true, render, Root };

// The provider bundle inlines this module, so a test that required the copy on
// disk would be driving a DIFFERENT runtime than the component - and every hook
// would report being called outside a render. Publishing the loaded instance is
// how the suite gets hold of the same one.
globalThis.__ITALA_REACT = module.exports;
