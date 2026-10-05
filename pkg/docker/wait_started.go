package docker

import (
	"context"
	"fmt"
	"time"

	"github.com/docker/docker/api/types/container"
)

// waitForStarted polls container state until it leaves "created" or the
// context is cancelled. Docker's Logs API does not follow a container that is
// not running, and returns EOF with no logs for a container in "created" state.
func (m *manager) waitForStarted(ctx context.Context, containerID string) error {
	for {
		inspect, err := m.client.ContainerInspect(ctx, containerID)
		if err != nil {
			return fmt.Errorf("inspecting container: %w", err)
		}

		if inspect.State != nil && inspect.State.Status != container.StateCreated {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
