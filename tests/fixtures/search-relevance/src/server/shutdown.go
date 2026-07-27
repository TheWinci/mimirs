package server

import (
	"context"
	"net/http"
	"time"
)

func recordAuditEvent(event string) {
	println("audit", event)
}

// GracefulShutdown drains in-flight HTTP requests before the process exits.
func GracefulShutdown(server *http.Server) error {
	recordAuditEvent("graceful-shutdown-started")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return server.Shutdown(ctx)
}
