package eest

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	// witness_generator_engine_block.json is block 11856702 of sepolia from the
	// stateless inputs catalog, with statelessInputBytes truncated. Its
	// engineNewPayloads carry the stateless bytes and only blockNumber and
	// gasUsed of the payload.
	witnessGeneratorEngineFixtureFile = "witness_generator_engine_block.json"
	witnessGeneratorEngineFixtureName = "witness-generator-spec-cli::" +
		"block_11856702_8a7bd6f47b12ecdc012b26ba13b097b93531abf5f885eab57a18037bebf1d126"
	witnessGeneratorEngineBlockHash = "0x8a7bd6f47b12ecdc012b26ba13b097b93531abf5f885eab57a18037bebf1d126"
)

func TestConvertStatelessFixture_WitnessGeneratorEngine(t *testing.T) {
	fixture := loadTestdataFixture(t, witnessGeneratorEngineFixtureFile, witnessGeneratorEngineFixtureName)

	require.True(t, fixture.IsStateless())
	require.True(t, fixture.IsSupportedFormat())
	require.Empty(t, fixture.EngineNewPayloads)
	require.Len(t, fixture.Blocks, 1)

	converted, err := ConvertStatelessFixture(witnessGeneratorEngineFixtureName, fixture)
	require.NoError(t, err)

	assert.Equal(t, witnessGeneratorEngineBlockHash, converted.FinalHash)
	require.Len(t, converted.TestLines, 1)

	call := decodeStatelessCall(t, converted.TestLines[0])
	assert.Equal(t, "engine_proveStatelessValidator", call.Method)
	assert.Equal(t, witnessGeneratorEngineBlockHash, call.Params[0]["blockHash"])
	assert.Equal(t, "0xb4eb3e", call.Params[0]["blockNumber"])
	assert.Equal(t, "0xbeffc3", call.Params[0]["gasUsed"])
	assert.Equal(t, "0x15011000000013450100a736aa00000000002c000000af43010020e9c5df5ac7", call.Params[0]["statelessInput"])
	assert.Equal(t, "0x2d4fd86355008f70a88dc29176ed83dd6a0080927a1415d31728f25dfea8b00501a736aa00000000000115",
		call.Params[0]["expectedStatelessOutput"])

	assert.Equal(t, uint64(11297199), fixture.Info.Metadata.WitnessGenerator.SlotNumber)
}
