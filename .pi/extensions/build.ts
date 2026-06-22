/**
 * Registers the /build command (the local coding pipeline) in the pi TUI.
 *
 * pi auto-loads .pi/extensions/*.ts; this thin re-export points at the pipeline
 * package's extension. The loader (jiti, tryNative disabled) follows the relative
 * import into the workspace source and transpiles the whole chain, so the live
 * src is used with no dist build required.
 */
export { default } from "../../packages/pipeline/src/extension.ts";
