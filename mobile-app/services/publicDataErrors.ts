type ErrorLike = {
  message?: string;
  code?: string;
};

export function isAuthError(error: unknown): boolean {
  const candidate = error as ErrorLike | null | undefined;
  const message = candidate?.message ?? '';

  return candidate?.code === 'PGRST303' || message.includes('JWT');
}

export function isNetworkError(error: unknown): boolean {
  const candidate = error as ErrorLike | null | undefined;
  const message = (candidate?.message ?? '').toLowerCase();

  return (
    message.includes('network request failed') ||
    message.includes('network error') ||
    message.includes('failed to fetch') ||
    message.includes('timeout') ||
    message.includes('offline')
  );
}
