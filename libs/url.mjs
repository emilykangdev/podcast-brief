export function cleanUrl(envVar) {
  const url = process.env[envVar];
  if (!url) throw new Error(`Missing required env var: ${envVar}`);
  return url.replace(/\/+$/, "");
}
