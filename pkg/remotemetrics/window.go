package remotemetrics

import (
	"math"
	"sort"
	"time"
)

// Stat is one metric reduced over one window. A counter reports Total and
// PeakRate, and a gauge reports Mean, Min and Max.
type Stat struct {
	Total float64 `json:"total,omitempty"`
	Mean  float64 `json:"mean,omitempty"`
	Min   float64 `json:"min,omitempty"`
	Max   float64 `json:"max,omitempty"`
	// PeakRate is the fastest a counter advanced between two source
	// refreshes, per second. A total spread over the whole window reports an
	// average, and an average hides the burst that saturates a link or a bus.
	PeakRate float64 `json:"peakRate,omitempty"`
}

// DeviceWindow holds every metric of one device over one window.
//
// Scrapes and Updates report how much data the window actually rests on.
// Scrapes counts the readings taken. Updates counts how many times the
// fastest counter changed, which is the rate the source refreshed at rather
// than the rate this package polled at. The two differ whenever the source
// slows down, and only Updates reveals it.
type DeviceWindow struct {
	Device   string            `json:"device"`
	Exporter string            `json:"exporter"`
	Labels   map[string]string `json:"labels"`
	Scrapes  int               `json:"scrapes"`
	Updates  int               `json:"updates"`
	Metrics  map[string]Stat   `json:"metrics"`
}

// Reduce cuts every device's samples to the window and reduces them.
func (s *Scraper) Reduce(start, end time.Time) []DeviceWindow {
	s.mu.Lock()
	defer s.mu.Unlock()

	byDevice := map[string]map[string]Stat{}
	scrapes := map[string]int{}
	updates := map[string]int{}

	for key, points := range s.points {
		stat, count, changes, ok := reduce(points, s.kinds[key.metric], start, end, s.interval)
		if !ok {
			continue
		}
		if byDevice[key.device] == nil {
			byDevice[key.device] = map[string]Stat{}
		}
		byDevice[key.device][key.metric] = stat
		if count > scrapes[key.device] {
			scrapes[key.device] = count
		}
		if s.kinds[key.metric] == KindCounter && changes > updates[key.device] {
			updates[key.device] = changes
		}
	}

	devices := make([]string, 0, len(byDevice))
	for device := range byDevice {
		devices = append(devices, device)
	}
	sort.Strings(devices)

	windows := make([]DeviceWindow, 0, len(devices))
	for _, device := range devices {
		windows = append(windows, DeviceWindow{
			Device:   device,
			Exporter: s.exporters[device],
			Labels:   s.devices[device],
			Scrapes:  scrapes[device],
			Updates:  updates[device],
			Metrics:  byDevice[device],
		})
	}
	return windows
}

// reduce turns one series into one statistic over the window. It reports the
// number of readings inside the window and, for a counter, how many times the
// value changed.
//
// Only the readings the window rests on take part. Reducing the whole buffer
// would let an event minutes away decide the result, and would read history
// the window never covered.
func reduce(points []point, kind Kind, start, end time.Time, interval time.Duration) (Stat, int, int, bool) {
	if len(points) == 0 || !covers(points, start, end) {
		return Stat{}, 0, 0, false
	}
	bracket := windowBracket(points, start, end)
	if !continuous(bracket, gapLimit(start, end, interval)) {
		return Stat{}, 0, 0, false
	}
	if kind == KindCounter {
		total, ok := counterTotal(bracket, start, end)
		if !ok {
			return Stat{}, 0, 0, false
		}
		count, changes := activity(bracket, start, end)
		return Stat{Total: total, PeakRate: peakRate(bracket, interval)}, count, changes, true
	}
	stat, count, ok := gaugeStat(bracket, start, end)
	if !ok {
		return Stat{}, 0, 0, false
	}
	return stat, count, 0, true
}

// windowBracket returns the readings a window rests on, which are the readings
// inside it plus the one on each side that its edges interpolate from.
//
// The buffer is sorted by arrival, so both edges are found by search. A block
// window covers a fraction of a second against a buffer holding minutes. The
// caller has already checked covers, which is what puts both edges inside the
// buffer.
func windowBracket(points []point, start, end time.Time) []point {
	first := sort.Search(len(points), func(i int) bool {
		return points[i].at.After(start)
	}) - 1
	last := sort.Search(len(points), func(i int) bool {
		return !points[i].at.Before(end)
	})

	return points[first : last+1]
}

// gapLimit reports how far apart two readings may fall before the span between
// them counts as unobserved.
//
// The limit follows the window as well as the poll rate. A stall of half a
// second hides most of a two second block and almost none of a ten minute one,
// so a fixed limit would either keep windows that rest on nothing or discard
// long windows over a moment of jitter.
func gapLimit(start, end time.Time, interval time.Duration) time.Duration {
	limit := interval * staleReadingFactor
	if share := end.Sub(start) / windowGapShare; share > limit {
		limit = share
	}

	return limit
}

// continuous reports whether readings arrived throughout the window. A gap
// wider than the limit means the source went unobserved, and interpolating
// across it would report work that nothing measured.
func continuous(points []point, limit time.Duration) bool {
	if limit <= 0 {
		return true
	}

	for i := 1; i < len(points); i++ {
		if points[i].at.Sub(points[i-1].at) > limit {
			return false
		}
	}

	return true
}

// covers reports whether the samples span the whole window. A window that
// starts before the first reading or ends after the last would otherwise
// report a total covering less time than it claims.
func covers(points []point, start, end time.Time) bool {
	return !points[0].at.After(start) && !points[len(points)-1].at.Before(end)
}

// counterTotal subtracts the counter across the window, interpolating at both
// edges because a scrape rarely lands on a window boundary.
//
// A counter that falls means the source restarted and its counter reset to
// zero, which makes any subtraction across that point meaningless. Only a
// reset inside the window matters, so the caller passes the bracketed
// readings and an earlier restart costs one block rather than every block
// still holding it in the buffer.
func counterTotal(points []point, start, end time.Time) (float64, bool) {
	for i := 1; i < len(points); i++ {
		if points[i].value < points[i-1].value {
			return 0, false
		}
	}
	first := interpolate(points, start)
	last := interpolate(points, end)
	if last < first {
		return 0, false
	}
	return last - first, true
}

// peakRate reports the fastest the counter advanced between two source
// refreshes, in units per second.
//
// A reading equal to the one before it counts as a scrape the source had not
// refreshed for, so rates run between changed readings. Dividing by the scrape
// interval would multiply the rate of a slow source by the scrapes each
// refresh spanned. The first change only marks a refresh instant, because the
// refresh before it lies outside the bracket. With one change the mean rate
// over the bracket stands in. A counter idle for several refreshes and then
// bursting reports the burst spread over the idle span, which is the
// accepted cost. Two readings closer than one poll cannot resolve the span
// between two refreshes, so the divisor holds at the poll interval.
func peakRate(points []point, interval time.Duration) float64 {
	var peak float64
	var refresh *point
	var changes int

	for i := 1; i < len(points); i++ {
		if points[i].value == points[i-1].value {
			continue
		}

		changes++

		if refresh != nil {
			if span := points[i].at.Sub(refresh.at).Seconds(); span > 0 {
				peak = math.Max(peak, (points[i].value-refresh.value)/math.Max(span, interval.Seconds()))
			}
		}

		refresh = &points[i]
	}

	if changes == 1 {
		if span := points[len(points)-1].at.Sub(points[0].at).Seconds(); span > 0 {
			peak = (points[len(points)-1].value - points[0].value) / span
		}
	}

	return peak
}

// interpolate reads the counter at an instant between two readings.
func interpolate(points []point, at time.Time) float64 {
	for i := 1; i < len(points); i++ {
		if points[i].at.Before(at) {
			continue
		}
		before, after := points[i-1], points[i]
		span := after.at.Sub(before.at)
		if span <= 0 {
			return after.value
		}
		ratio := float64(at.Sub(before.at)) / float64(span)
		return before.value + ratio*(after.value-before.value)
	}
	return points[len(points)-1].value
}

// activity counts the readings inside the window and how many of them changed
// the value, which is the source's own refresh rate.
func activity(points []point, start, end time.Time) (int, int) {
	var count, changes int
	previous := math.NaN()
	for _, p := range points {
		if p.at.Before(start) || p.at.After(end) {
			continue
		}
		count++
		if !math.IsNaN(previous) && p.value != previous {
			changes++
		}
		previous = p.value
	}
	return count, changes
}

// gaugeStat averages the readings inside the window and keeps both tails.
// Min matters as much as Max, because a headroom gauge is alarming when it is
// small.
func gaugeStat(points []point, start, end time.Time) (Stat, int, bool) {
	stat := Stat{Min: math.Inf(1), Max: math.Inf(-1)}
	var sum float64
	var count int
	for _, p := range points {
		if p.at.Before(start) || p.at.After(end) {
			continue
		}
		count++
		sum += p.value
		stat.Min = math.Min(stat.Min, p.value)
		stat.Max = math.Max(stat.Max, p.value)
	}
	if count == 0 {
		return Stat{}, 0, false
	}
	stat.Mean = sum / float64(count)
	return stat, count, true
}
