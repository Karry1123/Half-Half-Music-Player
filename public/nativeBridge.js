import { registerPlugin } from '@capacitor/core';

// Android injects Capacitor.nativePromise/nativeCallback, not registerPlugin.
// Plugin proxies must come from the JS SDK, including inside the dashboard bundle.
const plugins = new Map();
export function nativePlugin(name) {
  if (!plugins.has(name)) plugins.set(name, registerPlugin(name));
  return plugins.get(name);
}
