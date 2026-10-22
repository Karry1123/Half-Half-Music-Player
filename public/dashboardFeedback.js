export function createAppToast(publish, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer, sequence = 0;
  return (text, kind = 'info', options = {}) => {
    cancel(timer);
    const id = ++sequence;
    publish([{ id, key: options.key || 'app', text, kind, icon: options.icon }]);
    timer = schedule(() => publish([]), 2100);
  };
}

export const DOWNLOAD_KEY = 'hh.dashboard.downloads.v1';
export function restoreDownloads(storage) {
  try {
    return Object.fromEntries(Object.entries(JSON.parse(storage.getItem(DOWNLOAD_KEY) || '{}'))
      .filter(([, job]) => job?.result?.id && ['downloading', 'error'].includes(job.status))
      .map(([id, job]) => [id, { ...job, status: 'error', error: job.status === 'downloading' ? '已中断，请重新下载' : job.error }]));
  } catch { return {}; }
}
export function persistDownloads(storage, jobs) {
  try { storage.setItem(DOWNLOAD_KEY, JSON.stringify(Object.fromEntries(Object.entries(jobs).filter(([, j]) => j.status !== 'done')))); } catch {}
}
export function orderedDownloads(jobs) {
  const rank = { error: 0, downloading: 1, done: 2 };
  return Object.entries(jobs).sort((a, b) => rank[a[1].status] - rank[b[1].status] || b[1].createdAt - a[1].createdAt);
}
