type SupabaseErrorLike = {
  code?: string;
  message?: string;
};

export function isAuthRequiredInteractionError(error: unknown): boolean {
  const candidate = error as SupabaseErrorLike | null | undefined;
  const message = (candidate?.message ?? '').toLowerCase();
  return candidate?.code === '42501' || message.includes('row-level security');
}
