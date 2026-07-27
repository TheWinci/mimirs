export function recordAuditEvent(event: string, subjectId: string): void {
  console.info("audit", { event, subjectId });
}

export function recordSessionStarted(sessionId: string): void {
  recordAuditEvent("session-started", sessionId);
}
