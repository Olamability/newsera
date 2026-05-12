type SupabaseErrorLike = {
  code?: string;
  message?: string;
};

export class InteractionAuthRequiredError extends Error {
  readonly code = 'AUTH_REQUIRED';

  constructor() {
    super('You need to be logged in to comment or like.');
    this.name = 'InteractionAuthRequiredError';
  }
}

export function isAuthRequiredInteractionError(error: unknown): boolean {
  const candidate = error as SupabaseErrorLike | null | undefined;
  const message = (candidate?.message ?? '').toLowerCase();
  return (
    error instanceof InteractionAuthRequiredError ||
    candidate?.code === '42501' ||
    message.includes('row-level security')
  );
}
