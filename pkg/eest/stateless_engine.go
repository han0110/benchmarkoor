package eest

import (
	"encoding/json"
	"fmt"
)

// statelessEnginePayload is one engineNewPayloads entry of a stateless
// fixture. It carries the stateless validation bytes of its block and only the
// payload fields the stateless conversion reads.
type statelessEnginePayload struct {
	Params []struct {
		BlockNumber string `json:"blockNumber"`
		GasUsed     string `json:"gasUsed"`
	} `json:"params"`
	StatelessInputBytes  string `json:"statelessInputBytes"`
	StatelessOutputBytes string `json:"statelessOutputBytes"`
}

// UnmarshalJSON decodes a fixture. The engineNewPayloads of a stateless
// fixture without blocks decode into Blocks, so a stateless fixture converts
// the same way in the engine layout and in the blockchain-test layout.
func (f *Fixture) UnmarshalJSON(data []byte) error {
	type plainFixture Fixture

	var fixture struct {
		*plainFixture
		EngineNewPayloads json.RawMessage `json:"engineNewPayloads"`
	}

	fixture.plainFixture = (*plainFixture)(f)

	if err := json.Unmarshal(data, &fixture); err != nil {
		return err
	}

	if fixture.EngineNewPayloads == nil {
		return nil
	}

	if !f.IsStateless() || len(f.Blocks) > 0 {
		return json.Unmarshal(fixture.EngineNewPayloads, &f.EngineNewPayloads)
	}

	var payloads []statelessEnginePayload
	if err := json.Unmarshal(fixture.EngineNewPayloads, &payloads); err != nil {
		return fmt.Errorf("parsing stateless engineNewPayloads: %w", err)
	}

	for _, payload := range payloads {
		if len(payload.Params) == 0 {
			return fmt.Errorf("stateless engineNewPayload has no params")
		}

		f.Blocks = append(f.Blocks, &FixtureBlock{
			BlockHeader: &BlockHeader{
				Number:  payload.Params[0].BlockNumber,
				GasUsed: payload.Params[0].GasUsed,
			},
			StatelessInputBytes:  payload.StatelessInputBytes,
			StatelessOutputBytes: payload.StatelessOutputBytes,
		})
	}

	return nil
}
