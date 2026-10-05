//go:build e2e

// This file runs against the local Docker daemon.
//
//	go test ./pkg/docker/ -tags e2e -run TestStreamLogs -v
package docker

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/require"
)

// TestStreamLogsBeforeStart attaches to a created container before it starts,
// which is the order the runner uses.
func TestStreamLogsBeforeStart(t *testing.T) {
	ctx := context.Background()
	m, err := NewManager(logrus.New())
	require.NoError(t, err)
	require.NoError(t, m.Start(ctx))
	t.Cleanup(func() { _ = m.Stop() })

	const image = "busybox:latest"
	require.NoError(t, m.PullImage(ctx, image, "if-not-present"))

	containerID, err := m.CreateContainer(ctx, &ContainerSpec{
		Name:    "benchmarkoor-stream-logs-e2e",
		Image:   image,
		Command: []string{"echo", "stream-logs-e2e"},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = m.RemoveContainer(context.Background(), containerID) })

	var stdout, stderr bytes.Buffer
	streamDone := make(chan error, 1)
	go func() { streamDone <- m.StreamLogs(ctx, containerID, &stdout, &stderr) }()

	time.Sleep(500 * time.Millisecond)
	select {
	case err := <-streamDone:
		t.Fatalf("log stream ended before the container started: %v", err)
	default:
	}
	require.NoError(t, m.StartContainer(ctx, containerID))

	select {
	case err := <-streamDone:
		require.NoError(t, err)
	case <-time.After(30 * time.Second):
		t.Fatal("log stream did not end after the container exited")
	}
	require.Equal(t, "stream-logs-e2e\n", stdout.String())
}
