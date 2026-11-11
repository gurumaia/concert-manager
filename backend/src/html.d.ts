// esbuild inlines .html files as strings (see build.mjs).
declare module "*.html" {
  const html: string;
  export default html;
}
