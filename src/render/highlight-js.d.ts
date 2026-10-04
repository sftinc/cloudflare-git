// Stand-in for highlight.js's types (mapped in tsconfig paths): the real ones pull in the DOM lib, which clashes with the Workers types.
const hljs: {
  getLanguage(name: string): unknown;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
};
export default hljs;
