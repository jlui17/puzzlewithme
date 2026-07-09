// Declared so `process.env.NEXT_PUBLIC_SERVER_URL` is a known property (dot
// access, not an index signature): both to satisfy noPropertyAccessFromIndexSignature
// and because Next's build-time inlining of NEXT_PUBLIC_* only rewrites the dot
// form, so the value must be read that way to reach the browser bundle.
declare namespace NodeJS {
  interface ProcessEnv {
    NEXT_PUBLIC_SERVER_URL?: string;
  }
}
