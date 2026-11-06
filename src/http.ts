// The one door to the network. `main.ts` backs it with Obsidian's requestUrl;
// tests back it with a fake. Nothing else in the plugin reaches the network.

export type HttpRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HttpResponse = {
  status: number;
  json: unknown;
  headers: Record<string, string>;
  bytes: ArrayBuffer;
};

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
