/**
 * CSS side-effect imports need a declaration under TypeScript 5.6+/6.x strict
 * module resolution (TS2882). Next handles CSS itself, so this only teaches
 * `tsc` that `import "./globals.css"` is valid and should not be resolved.
 */
declare module "*.css";
