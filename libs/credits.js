export const MAX_EPISODE_SECONDS = 4 * 3600; // 14400

export function creditsNeeded(durationSeconds) {
  return Math.ceil(durationSeconds / 3600);
}

export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}
