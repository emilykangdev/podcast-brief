export function cleanUrl(envVar) {
  const url = process.env[envVar];
  if (!url) return "";
  return url.replace(/\/+$/, "");
}
