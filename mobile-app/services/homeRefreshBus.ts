export type HomeRefreshOrigin = 'active-tab-press' | 'pull-to-refresh';

export type HomeRefreshEvent = {
  requestId: number;
  origin: HomeRefreshOrigin;
  triggeredAt: number;
};

type HomeRefreshListener = (event: HomeRefreshEvent) => void;

const listeners = new Set<HomeRefreshListener>();
let requestId = 0;

export function subscribeToHomeRefresh(listener: HomeRefreshListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitHomeRefresh(origin: HomeRefreshOrigin): HomeRefreshEvent {
  requestId += 1;
  const event: HomeRefreshEvent = {
    requestId,
    origin,
    triggeredAt: Date.now(),
  };
  listeners.forEach((listener) => listener(event));
  return event;
}
