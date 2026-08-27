const mem = {};
module.exports = { default: {
  getItem: async k => mem[k] ?? null, setItem: async (k,v) => { mem[k]=v; },
  removeItem: async k => { delete mem[k]; }, clear: async () => {},
}};
