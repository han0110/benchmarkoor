package client

type provoorSpec struct{}

// NewProvoorSpec creates a new provoor forwarder specification. The provoor
// container forwards benchmark requests to a zkVM proving cluster, so it
// reads no chain data and boots with neither a genesis nor a datadir. The
// proving backend, stateless validator, and coordinator endpoint arrive
// through the instance extra_args.
func NewProvoorSpec() Spec {
	return &provoorSpec{}
}

// Ensure interface compliance.
var _ Spec = (*provoorSpec)(nil)

func (s *provoorSpec) Type() ClientType {
	return ClientProvoor
}

func (s *provoorSpec) DefaultImage() string {
	return "ghcr.io/han0110/provoor:latest"
}

func (s *provoorSpec) DefaultCommand() []string {
	return []string{"serve"}
}

func (s *provoorSpec) GenesisFlag() string {
	return ""
}

func (s *provoorSpec) RequiresInit() bool {
	return false
}

func (s *provoorSpec) InitCommand() []string {
	return nil
}

// DataDir gives the throwaway run volume a valid mount target; the forwarder
// never reads it.
func (s *provoorSpec) DataDir() string {
	return "/data"
}

// GenesisPath is empty because the forwarder reads no chain data, which also
// releases the lifecycle genesis requirement.
func (s *provoorSpec) GenesisPath() string {
	return ""
}

// JWTPath gives the JWT secret a valid mount target; the forwarder accepts
// requests without authentication.
func (s *provoorSpec) JWTPath() string {
	return "/tmp/jwtsecret"
}

func (s *provoorSpec) RPCPort() int {
	return 8551
}

func (s *provoorSpec) EnginePort() int {
	return 8551
}

func (s *provoorSpec) MetricsPort() int {
	return 0
}

func (s *provoorSpec) DefaultEnvironment() map[string]string {
	return nil
}

func (s *provoorSpec) RPCRollbackSpec() *RPCRollbackSpec {
	return nil
}

func (s *provoorSpec) DefaultConfigFiles() map[string]string {
	return nil
}

func (s *provoorSpec) SnapshotPrepareArgs() []string {
	return nil
}

// DBMaintenanceCommands returns nil; provoor proves blocks and keeps no
// database to compact.
func (s *provoorSpec) DBMaintenanceCommands(_ string) *DBMaintenanceCommands {
	return nil
}
