type AuthenticatedSession = {
  user: { id: string; name: string };
  session: { createdAt: Date | string };
};

export function authenticatedUserFromSession(session: AuthenticatedSession | null | undefined): { id: string; name: string } | null {
  return session?.user ? { id: session.user.id, name: session.user.name } : null;
}

export function sessionIsRecentForUser(session: AuthenticatedSession | null | undefined, userId: string): boolean {
  if (!session?.user || session.user.id !== userId) return false;
  const createdAt = new Date(session.session.createdAt).getTime();
  return Number.isFinite(createdAt) && Date.now() - createdAt <= 15 * 60 * 1000;
}
