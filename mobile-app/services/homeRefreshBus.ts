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
  const event: HomeRefreshEvent = {
    requestId: requestId + 1,
    origin,
    triggeredAt: Date.now(),
  };
  requestId = event.requestId;
  listeners.forEach((listener) => listener(event));
  return event;
}
